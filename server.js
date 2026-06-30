require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const app = express();
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

// ── Brevo client (HTTP-based — works on Render free tier) ────
async function sendBrevoEmail({ to, subject, textContent, htmlContent }) {
  const response = await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender: { name: "SafeRide SOS", email: "michealcraft022@gmail.com" },
      to,
      subject,
      textContent,
      htmlContent,
    },
    {
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "Content-Type": "application/json",
      },
    }
  );
  return response.data;
}

app.use(cors());
app.use(express.json());

/* =====================
   INITIALIZE PAYMENT
===================== */
app.post("/initialize-payment", async (req, res) => {
  const { email, amount, type, rideId } = req.body;

  if (!email || !amount) {
    return res.status(400).json({ error: "Email and amount are required" });
  }

  try {
    const payload = {
      email,
      amount: amount * 100,
      currency: "GHS",
      channels: ["mobile_money", "card"],
      metadata: {
        rideId: String(rideId),
        type: String(type ?? "ride"),
      },
    };

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("Init Payment Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Payment initialization failed" });
  }
});

/* =====================
   VERIFY PAYMENT
===================== */
app.get("/verify-payment", async (req, res) => {
  const { reference } = req.query;

  if (!reference) {
    return res.status(400).json({ status: false, message: "No reference provided" });
  }

  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}` } }
    );

    const paystackData = response.data;

    if (paystackData.status === true && paystackData.data.status === "success") {
      return res.json({
        status: true,
        message: "Payment verified successfully",
        data: paystackData.data,
      });
    } else {
      return res.json({
        status: false,
        message: "Payment not successful",
        data: paystackData.data,
      });
    }
  } catch (error) {
    console.error("Verify Error:", error.response?.data || error.message);
    return res.status(500).json({ status: false, message: "Verification failed" });
  }
});

/* =====================
   WALLET HELPER
===================== */
async function recordDriverEarning({
  driverUid,
  rideId,
  amount,
  rideType,
  driverPlate,
  pickupAddress,
  destinationAddress,
}) {
  if (!driverUid) {
    console.log("⚠️ No driverUid — skipping wallet record");
    return;
  }

  const walletRef = db.collection("driver_wallets").doc(driverUid);

  await db.runTransaction(async (txn) => {
    const snap = await txn.get(walletRef);
    const prev = snap.exists
      ? snap.data()
      : { total_accumulated: 0, available_balance: 0 };

    const newAccumulated = (prev.total_accumulated || 0) + amount;
    const newBalance = (prev.available_balance || 0) + amount;

    txn.set(
      walletRef,
      {
        total_accumulated: newAccumulated,
        available_balance: newBalance,
        last_updated: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const txRef = walletRef.collection("transactions").doc();
    txn.set(txRef, {
      type: "credit",
      amount,
      label: "Trip Payment",
      ride_id: rideId,
      ride_type: rideType || "unknown",
      car_plate: driverPlate || null,
      pickup_address: pickupAddress || null,
      destination_address: destinationAddress || null,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  console.log(`✅ Wallet updated for driver ${driverUid}: +GHS ${amount}`);
}

/* =====================
   PAYSTACK WEBHOOK
===================== */
app.post("/paystack-webhook", async (req, res) => {
  const event = req.body;
  console.log("FULL EVENT:", JSON.stringify(event, null, 2));

  try {
    if (event.event === "charge.success") {
      const reference = event.data.reference;
      const metaType = event.data.metadata?.type;
      const metaRideId = event.data.metadata?.rideId;

      // ── DEPOSIT ────────────────────────────────────────────────
      if (metaType === "deposit") {
        const uid = metaRideId; // Flutter passes uid as rideId for deposits
        const amount = event.data.amount / 100; // kobo → GHS

        if (!uid) {
          console.log("❌ Deposit webhook missing uid");
          return res.sendStatus(200);
        }

        const userRef = db.collection("users").doc(uid);

        // Idempotency: check if this reference was already processed
        const existingTx = await db
          .collection("users")
          .doc(uid)
          .collection("wallet_transactions")
          .where("reference", "==", reference)
          .limit(1)
          .get();

        if (!existingTx.empty) {
          console.log("⚠️ Deposit already processed for reference:", reference);
          return res.sendStatus(200);
        }

        await db.runTransaction(async (txn) => {
          txn.update(userRef, {
            wallet_balance: admin.firestore.FieldValue.increment(amount),
            deposit_skipped: false,
          });

          const txRef = userRef.collection("wallet_transactions").doc();
          txn.set(txRef, {
            type: "deposit",
            amount,
            reference,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
          });
        });

        console.log(`✅ Deposit of GHS ${amount} credited to user ${uid}`);
        return res.sendStatus(200);
      }

      // ── RIDE / CANCEL PAYMENT ──────────────────────────────────
      const snapshot = await db
        .collection("ride_requests")
        .where("payment_reference", "==", reference)
        .limit(1)
        .get();

      if (snapshot.empty) {
        console.log("❌ No ride found for reference:", reference);
        return res.sendStatus(200);
      }

      const rideDoc = snapshot.docs[0];
      const rideData = rideDoc.data();
      const rideRef = rideDoc.ref;

      console.log("✅ Found ride:", rideDoc.id);

      const type =
        rideData.cancel_payment_status === "pending" ? "cancel" : "ride";

      console.log("👉 Type:", type);

      if (type === "ride" && rideData.payment_status === "paid") {
        console.log("⚠️ Ride already paid, skipping...");
        return res.sendStatus(200);
      }

      if (type === "cancel" && rideData.cancel_payment_status === "paid") {
        console.log("⚠️ Cancel already paid, skipping...");
        return res.sendStatus(200);
      }

      if (type === "ride") {
        await rideRef.update({ payment_status: "paid" });
        console.log("✅ Ride payment updated");

        const fare = rideData.fare || 0;
        await recordDriverEarning({
          driverUid: rideData.driver_id,
          rideId: rideDoc.id,
          amount: fare,
          rideType: rideData.ride_type,
          driverPlate: rideData.car_plate,
          pickupAddress: rideData.pickup_address,
          destinationAddress: rideData.destination_address,
        });
      }

      if (type === "cancel") {
        await rideRef.update({
          cancel_payment_status: "paid",
          status: "cancelled",
        });
        console.log("✅ Cancel payment updated");
      }

      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error.message || error);
    res.sendStatus(500);
  }
});

/* =====================
   DEDUCT WALLET
   Called by Flutter when rider pays cancellation fee from wallet.
   Uses Admin SDK so it bypasses Firestore security rules.
===================== */
app.post("/deduct-wallet", async (req, res) => {
  const { uid, amount, rideId, type } = req.body;

  if (!uid || !amount || !rideId) {
    return res.status(400).json({ error: "uid, amount, and rideId are required" });
  }

  const userRef = db.collection("users").doc(uid);
  const rideRef = db.collection("ride_requests").doc(rideId);

  try {
    let balanceAfter = 0;

    await db.runTransaction(async (txn) => {
      const userSnap = await txn.get(userRef);
      const userData = userSnap.data();
      const balance = (userData?.wallet_balance ?? 0);

      if (balance < amount) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      balanceAfter = balance - amount;

      let riderName = `${userData?.firstName ?? ""} ${userData?.lastName ?? ""}`.trim();
      if (!riderName) riderName = "Rider";

      txn.update(userRef, {
        wallet_balance: admin.firestore.FieldValue.increment(-amount),
      });

      txn.update(rideRef, {
        cancel_payment_status: "paid",
        status: "cancelled",
        rider_cancelled_name: riderName,
        cancel_payment_method: "wallet",
      });

      const txRef = userRef.collection("wallet_transactions").doc();
      txn.set(txRef, {
        type: type ?? "cancel_fee",
        amount,
        ride_id: rideId,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    console.log(`✅ Deducted GHS ${amount} from user ${uid} for ride ${rideId}`);
    res.json({ success: true, balance_after: balanceAfter });
  } catch (error) {
    if (error.message === "INSUFFICIENT_BALANCE") {
      return res.status(402).json({ error: "INSUFFICIENT_BALANCE" });
    }
    console.error("Deduct wallet error:", error.message || error);
    res.status(500).json({ error: "Deduction failed" });
  }
});

/* =====================
   SEND SOS EMAIL
===================== */
app.post("/send-sos-email", async (req, res) => {
  const { alertId, userId, rideId, driverPlate, lat, lng, mapsLink } = req.body;

  if (!alertId || !userId) {
    return res.status(400).json({ error: "alertId and userId are required" });
  }

  try {
    console.log("SOS userId received:", userId);

    const contactsSnap = await db
      .collection("users")
      .doc(userId)
      .collection("emergency_contacts")
      .get();

    const contacts = contactsSnap.docs.map((d) => d.data());
    console.log("Contacts found:", contacts.length, contacts);

    const subject = "🚨 SOS Emergency Alert";

    const buildText = (recipientName) => {
      const location = mapsLink
        ? `View live location: ${mapsLink}`
        : "Location unavailable";
      const plateInfo = driverPlate ? `\nTricycle plate: ${driverPlate}` : "";
      return (
        `Hi ${recipientName},\n\n` +
        `EMERGENCY: A passenger needs immediate help.${plateInfo}\n\n` +
        `${location}\n\n` +
        `Please call emergency services or check on them immediately.`
      );
    };

    const buildHtml = (recipientName) => {
      const location = mapsLink
        ? `<a href="${mapsLink}" style="color:#c0392b;">📍 View live location on Google Maps</a>`
        : "<span>📍 Location unavailable</span>";
      const plateInfo = driverPlate
        ? `<p style="margin:0 0 8px;"><strong>🛺 Tricycle plate:</strong> ${driverPlate}</p>`
        : "";
      return `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #f5c6cb;border-radius:12px;background:#fff8f8;">
          <h2 style="color:#c0392b;margin-top:0;">🚨 SOS Emergency Alert</h2>
          <p style="margin:0 0 8px;">Hi <strong>${recipientName}</strong>,</p>
          <p style="margin:0 0 16px;color:#333;">A passenger using <strong>SafeRide</strong> needs <strong>immediate help</strong>.</p>
          ${plateInfo}
          <p style="margin:0 0 16px;">${location}</p>
          <p style="margin:0;color:#555;">Please call emergency services (<strong>191</strong>) or check on them immediately.</p>
          <hr style="margin:24px 0;border:none;border-top:1px solid #f5c6cb;" />
          <p style="font-size:12px;color:#999;margin:0;">Sent automatically by SafeRide Safety System.</p>
        </div>
      `;
    };

    const recipients = [
      ...contacts
        .filter((c) => c.email)
        .map((c) => ({ name: c.name || "Contact", email: c.email })),
      { name: "Support Team", email: "michealcraft022@gmail.com" },
    ];

    console.log("Total recipients:", recipients.length, recipients.map(r => r.email));

    let sentCount = 0;
    for (const r of recipients) {
      try {
        await sendBrevoEmail({
          to: [{ email: r.email, name: r.name }],
          subject,
          textContent: buildText(r.name),
          htmlContent: buildHtml(r.name),
        });
        console.log(`📩 SOS email sent to: ${r.email}`);
        sentCount++;
      } catch (err) {
        console.error(`❌ Failed to send to ${r.email}:`, err.message);
        if (err.response) {
          console.error(`   Brevo status: ${err.response.status}`);
          console.error(`   Brevo body:`, JSON.stringify(err.response.data));
        }
      }
    }

    await db.collection("sos_alerts").doc(alertId).set(
      {
        emails_sent: true,
        emails_sent_at: admin.firestore.FieldValue.serverTimestamp(),
        notified_count: sentCount,
      },
      { merge: true }
    );

    console.log(`✅ SOS done — sent ${sentCount}/${recipients.length} emails for alert ${alertId}`);
    res.json({ success: true, sent_to: sentCount, total: recipients.length });
  } catch (error) {
    console.error("SOS email error:", error.message || error);
    if (error.response) {
      console.error("Brevo status:", error.response.status);
      console.error("Brevo body:", JSON.stringify(error.response.data));
    }
    res.status(500).json({ error: "Failed to send SOS emails" });
  }
});

/* =====================
   TEST FIRESTORE
===================== */
app.get("/test-firestore", async (req, res) => {
  try {
    await db.collection("test").add({ ok: true, time: new Date() });
    res.send("Firestore write successful");
  } catch (err) {
    console.error("Firestore test error:", err);
    res.status(500).send(err.message);
  }
});

/* =====================
   TEST EMAIL
===================== */
app.get("/test-email", async (req, res) => {
  try {
    const result = await sendBrevoEmail({
      to: [{ email: "michealcraft022@gmail.com", name: "Test" }],
      subject: "Test from server",
      textContent: "If you see this, Brevo is working.",
      htmlContent: "<p>If you see this, <b>Brevo is working.</b></p>",
    });
    console.log("Test email result:", JSON.stringify(result));
    res.json({ success: true, result });
  } catch (err) {
    console.error("Test email error:", err.message);
    if (err.response) {
      console.error("Brevo status:", err.response.status);
      console.error("Brevo body:", JSON.stringify(err.response.data));
    }
    res.status(500).json({
      error: err.message,
      brevo: err.response?.data ?? null,
    });
  }
});

/* =====================
   ASSIGN DELIVERY MAN
===================== */
app.post("/assign-delivery-man", async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: "orderId required" });

  try {
    const orderRef = db.collection("delivery_orders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return res.status(404).json({ error: "Order not found" });

    const orderData = orderSnap.data();
    const restaurantLat = orderData.restaurant_lat;
    const restaurantLng = orderData.restaurant_lng;
    const rejectedBy = orderData.rejected_by || [];

    const deliveryMenSnap = await db
      .collection("delivery_men")
      .where("is_online", "==", true)
      .get();

    const available = deliveryMenSnap.docs.filter((doc) => {
      const d = doc.data();
      return (
        !d.active_order_id &&
        d.current_lat != null &&
        d.current_lng != null &&
        !rejectedBy.includes(doc.id)
      );
    });

    if (available.length === 0) {
      return res.json({ assigned: false, message: "No delivery men available" });
    }

    function haversineKm(lat1, lng1, lat2, lng2) {
      const R = 6371;
      const dLat = ((lat2 - lat1) * Math.PI) / 180;
      const dLng = ((lng2 - lng1) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
          Math.cos((lat2 * Math.PI) / 180) *
          Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    let nearest = null;
    let minDist = Infinity;

    for (const doc of available) {
      const d = doc.data();
      const dist = haversineKm(
        restaurantLat, restaurantLng,
        d.current_lat, d.current_lng
      );
      if (dist < minDist) {
        minDist = dist;
        nearest = { id: doc.id, dist };
      }
    }

    await orderRef.update({
      target_delivery_man_id: nearest.id,
      target_distance_km: minDist,
    });

    console.log(`✅ Order ${orderId} assigned to ${nearest.id} (${minDist.toFixed(2)} km)`);
    res.json({ assigned: true, delivery_man_id: nearest.id, distance_km: minDist });
  } catch (error) {
    console.error("Assign delivery man error:", error.message);
    res.status(500).json({ error: "Assignment failed" });
  }
});

console.log("PAYSTACK KEY LOADED:", !!process.env.PAYSTACK_SECRET);
console.log("BREVO KEY LOADED:", !!process.env.BREVO_API_KEY);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});