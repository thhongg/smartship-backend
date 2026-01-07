import mqtt from "mqtt";
import "dotenv/config";

const IMAGE_BASE_URL =
  "https://pub-cc75337d33a94efcae6e9d7fddbfaf8a.r2.dev/latest.jpg";

// STATE CHIA SẺ CHO FRONTEND
let latestStatus = {
  weight: 0,
  detected: false,
  imageUrl: IMAGE_BASE_URL,
  aiResult: null,
};

let aiConfig = {
  enabled: false,
  lastResult: null,
};
let aiInferenceRunning = false;

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

      latestStatus.imageUrl = `${IMAGE_BASE_URL}?t=${Date.now()}`;

      if (aiConfig.enabled && !aiInferenceRunning) {
        aiInferenceRunning = true;
        runAIInference().finally(() => {
          aiInferenceRunning = false;
        });
      }
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

async function runAIInference() {
  try {
    console.log("Running AI inference on:", latestStatus.imageUrl);

    // Chờ ảnh chắc chắn tồn tại trên R2
    await new Promise((r) => setTimeout(r, 300));

    const imgRes = await fetch(latestStatus.imageUrl, {
      cache: "no-store",
    });
    if (!imgRes.ok) {
      throw new Error("Failed to fetch image from R2");
    }

    const imgBuffer = await imgRes.arrayBuffer();

    const form = new FormData();
    form.append(
      "model",
      "https://hub.ultralytics.com/models/kxpiyKC1moNO87JkbXlr"
    );
    form.append("imgsz", "640");
    form.append("conf", "0.25");
    form.append("iou", "0.45");
    form.append(
      "file",
      new Blob([imgBuffer], { type: "image/jpeg" }),
      "latest.jpg"
    );

    const res = await fetch("https://predict.ultralytics.com", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ULTRALYTICS_API_KEY,
      },
      body: form,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI API failed: ${res.status} ${text}`);
    }

    const result = await res.json();

    const detections = result?.images?.[0]?.results || [];
    console.log("Detections:", detections);

    // ✅ LƯU STATE CHO FRONTEND
    aiConfig.lastResult = result;
    latestStatus.aiResult = result;
    latestStatus.updatedAt = Date.now();

    console.log("AI inference completed");
  } catch (err) {
    console.error("AI inference failed:", err);
  }
}

export default client;

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/status", (req, res) => {
  res.json({
    ...latestStatus,
    aiEnabled: aiConfig.enabled,
    aiResult: aiConfig.lastResult,
  });
});

app.post("/config/ai", (req, res) => {
  const { enabled } = req.body;
  aiConfig.enabled = !!enabled;

  if (aiConfig.enabled && latestStatus.detected && !aiInferenceRunning) {
    aiInferenceRunning = true;
    runAIInference().finally(() => {
      aiInferenceRunning = false;
    });
  }

  res.json({ ok: true, aiEnabled: aiConfig.enabled });
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("HTTP server listening on port", PORT);
});
