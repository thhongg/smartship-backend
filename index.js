import mqtt from "mqtt";
import "dotenv/config";
// STATE CHIA SẺ CHO FRONTEND
let latestStatus = {
  weight: 0,
  detected: false,
  imageUrl: "https://pub-cc75337d33a94efcae6e9d7fddbfaf8a.r2.dev/latest.jpg",
};

const brokerUrl = process.env.MQTT_BROKER;

const options = {
  clientId: "backend_" + Math.random().toString(16).substring(2, 8),
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
};

const client = mqtt.connect(brokerUrl, options);

// State variable to track if a good has been detected
let isGoodDetected = false;

const TOPIC_OBJECT_DETECTION = "v1/delivery/sensor/ultrasonic";
const TOPIC_COMMAND_STATUS = "v1/delivery/command/status";
const TOPIC_DISPLAY_LCD = "v1/delivery/display/lcd";
const TOPIC_WEIGHT = "v1/delivery/sensor/weight";

client.on("connect", () => {
  console.log("Connected to MQTT broker");
  // Subscribe to relevant topics from ESP32
  client.subscribe(TOPIC_OBJECT_DETECTION, { qos: 1 });
  client.subscribe(TOPIC_WEIGHT, { qos: 1 });
});

client.on("error", (err) => {
  console.error("MQTT connection error:", err);
});

client.on("message", (topic, message) => {
  switch (topic) {
    case TOPIC_OBJECT_DETECTION:
      handleObjectDetection(message);
      break;
    case TOPIC_WEIGHT:
      handleWeight(message);
      break;
    default:
      console.log(`Received message on unknown topic: ${topic}`);
  }
});

function handleObjectDetection(message) {
  try {
    const payload = JSON.parse(message.toString());

    if (typeof payload.detected !== "boolean") {
      console.warn("Invalid detected payload:", payload);
      return;
    }

    if (payload.detected) {
      console.log("Object detected.");
      isGoodDetected = true;
      latestStatus.detected = true;
    } else {
      console.log("Object left sensor. Making decision.");

      if (isGoodDetected) {
        if (
          typeof latestStatus.weight !== "number" ||
          latestStatus.weight <= 0
        ) {
          console.warn("No valid weight yet. Skipping decision.");
        } else {
          const isGoodAccepted =
            typeof latestStatus.weight === "number" && latestStatus.weight > 0;

          const action = isGoodAccepted ? "ACCEPT" : "REJECT";

          client.publish(TOPIC_COMMAND_STATUS, JSON.stringify({ action }), {
            qos: 1,
          });

          client.publish(
            TOPIC_DISPLAY_LCD,
            JSON.stringify({
              line1: action === "ACCEPT" ? "Accepted" : "Rejected",
              line2: "",
            }),
            { qos: 1 }
          );
        }
      }
      // reset state
      isGoodDetected = false;
      latestStatus.detected = false;
      latestStatus.updatedAt = Date.now();
    }
  } catch (e) {
    console.error("Failed to parse object detection message:", e);
  }
}

function handleWeight(message) {
  try {
    const payload = JSON.parse(message.toString());
    const weight = payload.weight;

    if (typeof weight === "number") {
      console.log(`Received weight: ${weight} kg`);

      // ✅ UPDATE CHO FRONTEND
      latestStatus.weight = weight;
    }
  } catch (e) {
    console.error("Failed to parse weight message:", e);
  }
  latestStatus.updatedAt = Date.now();
}

export default client;

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ====== HTTP API CHO FRONTEND ======
app.get("/status", (req, res) => {
  res.json(latestStatus);
});

app.post("/decision", (req, res) => {
  const { decision } = req.body; // "ACCEPT" | "REJECT"

  // 1. GỬI COMMAND → ESP32 sẽ play audio tương ứng
  client.publish(TOPIC_COMMAND_STATUS, JSON.stringify({ action: decision }), {
    qos: 1,
  });

  // 2. GỬI LCD
  client.publish(
    TOPIC_DISPLAY_LCD,
    JSON.stringify({
      line1: decision === "ACCEPT" ? "Accepted" : "Rejected",
      line2: decision === "REJECT" ? "Prohibited" : "",
    }),
    { qos: 1 }
  );

  console.log("Manual decision sent to ESP32:", decision);
  res.json({ ok: true });
});

// ====== LISTEN PORT (QUAN TRỌNG) ======
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("HTTP server listening on port", PORT);
});
