
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");

const app = express();
const admin = require("firebase-admin");

// Load service account
const serviceAccount = require(path.resolve(__dirname, "serviceAccountKey.json"));

// Debug credentials
console.log("Firebase Project:", serviceAccount.project_id);
console.log("Service Account Email:", serviceAccount.client_email);
console.log("Private Key Length:", serviceAccount.private_key?.length);

// Initialize Firebase
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

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
   PAYSTACK WEBHOOK
===================== */
app.post("/paystack-webhook", async (req, res) => {
  const event = req.body;

  console.log("FULL EVENT:", JSON.stringify(event, null, 2));

  try {
    if (event.event === "charge.success") {
      const reference = event.data.reference;

      // 🔥 Look up ride by reference instead of relying on metadata
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

      // Ride payment
      if (type === "ride") {
        await rideRef.update({ payment_status: "paid" });
        console.log("✅ Ride payment updated");
      }

      // Cancel payment
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
