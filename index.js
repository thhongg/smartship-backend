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
const TOPIC_IMAGE_UPLOAD = "v1/delivery/camera/image";
const TOPIC_COMMAND_STATUS = "v1/delivery/command/status";
const TOPIC_AUDIO_PLAY = "v1/delivery/audio/play";
const TOPIC_DISPLAY_LCD = "v1/delivery/display/lcd";
const TOPIC_WEIGHT = "v1/delivery/sensor/weight";

client.on("connect", () => {
  console.log("Connected to MQTT broker");
  // Subscribe to relevant topics from ESP32
  client.subscribe(TOPIC_OBJECT_DETECTION, { qos: 1 });
  client.subscribe(TOPIC_IMAGE_UPLOAD, { qos: 1 });
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
    case TOPIC_IMAGE_UPLOAD:
      handleImageUpload(message);
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
    if (payload.detected) {
      console.log("Object detected. Waiting for image...");
      isGoodDetected = true;

      // ✅ UPDATE CHO FRONTEND
      latestStatus.detected = true;
    }
  } catch (e) {
    console.error("Failed to parse object detection message:", e);
  }
}

function handleImageUpload(message) {
  if (!isGoodDetected) {
    console.log("Image received without prior good detection. Ignoring.");
    return;
  }

  console.log("Image received.");

  // Step 1: Image is received. Simulate image analysis.
  const isGoodAccepted = 1; // 50% chance of acceptance

  if (isGoodAccepted) {
    console.log("Image analysis: Good accepted.");
    // Step 2: Publish commands for ACCEPT
    client.publish(TOPIC_COMMAND_STATUS, JSON.stringify({ action: "ACCEPT" }), {
      qos: 1,
    });
    client.publish(TOPIC_AUDIO_PLAY, JSON.stringify({ track_id: 1 }), {
      qos: 1,
    });
    client.publish(
      TOPIC_DISPLAY_LCD,
      JSON.stringify({ line1: "Accepted", line2: "" }),
      { qos: 1 }
    );
  } else {
    console.log("Image analysis: Good rejected.");
    // Step 2: Publish commands for REJECT
    client.publish(TOPIC_COMMAND_STATUS, JSON.stringify({ action: "REJECT" }), {
      qos: 1,
    });
    client.publish(TOPIC_AUDIO_PLAY, JSON.stringify({ track_id: 2 }), {
      qos: 1,
    }); // Assuming track 2 is for rejection
    client.publish(
      TOPIC_DISPLAY_LCD,
      JSON.stringify({ line1: "Rejected", line2: "Prohibited" }),
      { qos: 1 }
    );
  }

  // Reset the detection flag to wait for the next cycle
  isGoodDetected = false;
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
}

export default client;
function publishCommand(action) {
  client.publish(TOPIC_COMMAND_STATUS, JSON.stringify({ action }), { qos: 1 });
}

function playAudio(track_id) {
  client.publish(TOPIC_AUDIO_PLAY, JSON.stringify({ track_id }), { qos: 1 });
}

function displayLCD(line1, line2 = "") {
  client.publish(TOPIC_DISPLAY_LCD, JSON.stringify({ line1, line2 }), {
    qos: 1,
  });
}

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
  const { decision } = req.body;
  console.log("Decision from frontend:", decision);
  res.json({ ok: true });
});

// ====== LISTEN PORT (QUAN TRỌNG) ======
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("HTTP server listening on port", PORT);
});
