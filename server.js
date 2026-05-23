require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");

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
    const prev = snap.exists ? snap.data() : { total_accumulated: 0, available_balance: 0 };

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

      // Look up ride by reference
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

      // Determine payment type from Firestore state
      const type = rideData.cancel_payment_status === "pending" ? "cancel" : "ride";

      console.log("👉 Type:", type);

      // Prevent duplicates
      if (type === "ride" && rideData.payment_status === "paid") {
        console.log("⚠️ Ride already paid, skipping...");
        return res.sendStatus(200);
      }

      if (type === "cancel" && rideData.cancel_payment_status === "paid") {
        console.log("⚠️ Cancel already paid, skipping...");
        return res.sendStatus(200);
      }

      // Ride payment — mark paid then record in driver wallet
      if (type === "ride") {
        await rideRef.update({ payment_status: "paid" });
        console.log("✅ Ride payment updated");

        // Record earning in driver's wallet
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

      // Cancel payment — just mark paid, no driver earning
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

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});