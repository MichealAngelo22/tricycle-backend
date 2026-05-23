require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const nodemailer = require("nodemailer");

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

// ── Email transporter ─────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

app.use(cors());
app.use(express.json());

/* =====================
   INITIALIZE PAYMENT
===================== */
app.post("/initialize-payment", async (req, res) => {
  const { email, amount, type, rideId } = req.body;

  if (!email || !amount) {
    return res.status(400).json({
      error: "Email and amount are required",
    });
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
    res.status(500).json({
      error: "Payment initialization failed",
    });
  }
});

/* =====================
   VERIFY PAYMENT
===================== */
app.get("/verify-payment", async (req, res) => {
  const { reference } = req.query;

  if (!reference) {
    return res.status(400).json({
      status: false,
      message: "No reference provided",
    });
  }

  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
        },
      }
    );

    const paystackData = response.data;

    if (
      paystackData.status === true &&
      paystackData.data.status === "success"
    ) {
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
    return res.status(500).json({
      status: false,
      message: "Verification failed",
    });
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
      driver_plate: driverPlate || null,
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
          driverPlate: rideData.driver_plate,
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
   SEND SOS EMAIL
===================== */
app.post("/send-sos-email", async (req, res) => {
  const { alertId, userId, rideId, driverPlate, lat, lng, mapsLink } = req.body;

  if (!alertId || !userId) {
    return res.status(400).json({ error: "alertId and userId are required" });
  }

  try {
    // Load emergency contacts from Firestore
    const contactsSnap = await db
      .collection("users")
      .doc(userId)
      .collection("emergency_contacts")
      .get();

    const contacts = contactsSnap.docs.map((d) => d.data());

    const subject = "🚨 SOS Emergency Alert";

    const buildBody = (recipientName) => {
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

    // All recipients: emergency contacts + support
    const recipients = [
      ...contacts
        .filter((c) => c.email)
        .map((c) => ({ name: c.name || "Contact", email: c.email })),
      { name: "Support Team", email: "michealcraft022@gmail.com" },
    ];

    // Send all emails in parallel
    for (const r of recipients) {
  try {
    await transporter.sendMail({
      from: `"SafeRide SOS" <${process.env.EMAIL_USER}>`,
      to: r.email,
      subject,
      text: buildBody(r.name),
    });

    console.log(`📩 Email sent to: ${r.email}`);
  } catch (err) {
    console.log(`❌ Failed email: ${r.email}`, err.message);
  }
}

    // Update alert to record that emails were sent
    await db.collection("sos_alerts").doc(alertId).update({
      emails_sent: true,
      emails_sent_at: admin.firestore.FieldValue.serverTimestamp(),
      notified_count: recipients.length,
    });

    console.log(
      `✅ SOS emails sent for alert ${alertId} to ${recipients.length} recipients`
    );
    res.json({ success: true, sent_to: recipients.length });
  } catch (error) {
    console.error("SOS email error:", error.message || error);
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

console.log("PAYSTACK KEY LOADED:", !!process.env.PAYSTACK_SECRET);

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});