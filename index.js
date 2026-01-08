import mqtt from "mqtt";
import "dotenv/config";
// import thư viện MQTT và load biến môi trường từ file .env

const IMAGE_BASE_URL =
  "https://pub-cc75337d33a94efcae6e9d7fddbfaf8a.r2.dev/latest.jpg";
// URL ảnh mới nhất được ESP32-CAM upload lên R2 (frontend sẽ hiển thị ảnh này)

const WORKER_BASE_URL = "https://tiny-snow-d7fd.thachchithong3.workers.dev";
// backend worker dùng để lưu transaction (decision + weight)

// hàm gọi backend worker để lưu dữ liệu quyết định là accept hay reject
async function saveTransaction({ decision, weight }) {
  try {
    await fetch(`${WORKER_BASE_URL}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, weight }),
    });
  } catch (err) {
    console.error("Failed to save transaction:", err);
  }
}

// STATE CHIA SẺ CHO FRONTEND
let latestStatus = {
  weight: 0, // cân nặng mới nhất nhận từ cảm biến
  detected: false, // trạng thái có vật trước sensor hay không
  imageUrl: IMAGE_BASE_URL, // link ảnh hiện tại
  aiResult: null, // kết quả AI model (nếu có)
};

let aiConfig = {
  enabled: false, // bật / tắt AI từ frontend
  lastResult: null, // kết quả AI gần nhất
};
let aiInferenceRunning = false;
// cờ chống chạy AI inference trùng nhau

const brokerUrl = process.env.MQTT_BROKER;
// URL MQTT broker (HiveMQ Cloud) lấy từ biến môi trường khi deploy railway

const options = {
  clientId: "backend_" + Math.random().toString(16).substring(2, 8),
  // tạo clientId ngẫu nhiên cho backend

  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  // thông tin đăng nhập MQTT
};

const client = mqtt.connect(brokerUrl, options);
// kết nối backend Node.js tới MQTT broker

let isGoodDetected = false;
// State để nhớ xem hàng đã từng được phát hiện hay chưa

// Định nghĩa các topic MQTT
const TOPIC_OBJECT_DETECTION = "v1/delivery/sensor/ultrasonic";
// topic ESP32 gửi trạng thái phát hiện vật

const TOPIC_COMMAND_STATUS = "v1/delivery/command/status";
// topic backend gửi lệnh ACCEPT / REJECT tới ESP32

const TOPIC_DISPLAY_LCD = "v1/delivery/display/lcd";
// topic backend gửi lệnh hiển thị lên LCD

const TOPIC_WEIGHT = "v1/delivery/sensor/weight";
// topic ESP32 gửi dữ liệu cân nặng

client.on("connect", () => {
  console.log("Connected to MQTT broker");
  // khi backend kết nối thành công tới MQTT broker

  // đăng ký lắng nghe topic cảm biến từ ESP32
  client.subscribe(TOPIC_OBJECT_DETECTION, { qos: 1 });
  client.subscribe(TOPIC_WEIGHT, { qos: 1 });
});

client.on("error", (err) => {
  // log lỗi nếu MQTT gặp sự cố
  console.error("MQTT connection error:", err);
});

client.on("message", (topic, message) => {
  // nhận message từ MQTT và phân luồng xử lý theo topic

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

async function handleObjectDetection(message) {
  // xử lý dữ liệu phát hiện vật từ ESP32

  try {
    const payload = JSON.parse(message.toString());

    // kiểm tra payload có đúng định dạng không
    if (typeof payload.detected !== "boolean") {
      console.warn("Invalid detected payload:", payload);
      return;
    }

    if (payload.detected) {
      // khi cảm biến phát hiện có vật
      console.log("Object detected.");
      isGoodDetected = true;
      latestStatus.detected = true;

      // cập nhật URL ảnh và thêm timestamp để tránh cache không load ảnh
      latestStatus.imageUrl = `${IMAGE_BASE_URL}?t=${Date.now()}`;

      // nếu AI được bật và chưa chạy inference thì chạy aimodel
      if (aiConfig.enabled && !aiInferenceRunning) {
        aiInferenceRunning = true;
        runAIInference().finally(() => {
          aiInferenceRunning = false;
        });
      }
    } else {
      console.log("Object left sensor. Making decision.");
      // khi vật rời khỏi vùng cảm biến

      if (isGoodDetected) {
        // chỉ quyết định nếu trước đó đã từng phát hiện vật

        if (
          typeof latestStatus.weight !== "number" ||
          latestStatus.weight <= 0
        ) {
          // chưa có dữ liệu cân hợp lệ
          console.warn("No valid weight yet. Skipping decision.");
        } else {
          // xác định kết quả dựa trên cân nặng
          const isGoodAccepted =
            typeof latestStatus.weight === "number" && latestStatus.weight > 0;

          const action = isGoodAccepted ? "ACCEPT" : "REJECT";

          // gửi lệnh ACCEPT / REJECT xuống ESP32
          client.publish(TOPIC_COMMAND_STATUS, JSON.stringify({ action }), {
            qos: 1,
          });

          // lưu transaction vào backend worker
          await saveTransaction({
            decision: action,
            weight: latestStatus.weight,
          });

          // gửi nội dung hiển thị lên LCD
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
      // reset trạng thái sau khi xử lý xong một vật
      isGoodDetected = false;
      latestStatus.detected = false;
      latestStatus.updatedAt = Date.now();
    }
  } catch (e) {
    console.error("Failed to parse object detection message:", e);
  }
}

function handleWeight(message) {
  // xử lý dữ liệu cân nặng gửi từ ESP32

  try {
    const payload = JSON.parse(message.toString());
    const weight = payload.weight;

    if (typeof weight === "number") {
      console.log(`Received weight: ${weight} kg`);

      // cập nhật cân nặng cho frontend sử dụng
      latestStatus.weight = weight;
    }
  } catch (e) {
    console.error("Failed to parse weight message:", e);
  }
  // cập nhật thời điểm nhận dữ liệu
  latestStatus.updatedAt = Date.now();
}

async function removeBackground(imageBuffer) {
  // gọi API remove.bg để xóa nền ảnh

  const form = new FormData();
  form.append(
    "image_file",
    new Blob([imageBuffer], { type: "image/jpeg" }),
    "input.jpg"
  );
  form.append("size", "auto");
  form.append("format", "jpg"); // ép output thành JPG
  form.append("bg_color", "ffffff"); // nền trắng
  const res = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.REMOVEBG_API_KEY,
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("remove.bg failed: " + text);
  }

  // trả về buffer ảnh đã xóa nền
  return await res.arrayBuffer();
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

    const originalBuffer = await imgRes.arrayBuffer();

    // xóa nền ảnh trước khi đưa vào AI
    const bgRemovedBuffer = await removeBackground(originalBuffer);

    // tạo form gửi lên Ultralytics API
    const form = new FormData();
    form.append(
      "model",
      "https://hub.ultralytics.com/models/kxpiyKC1moNO87JkbXlr"
    );
    form.append("imgsz", "640");
    form.append("conf", "0.15");
    form.append("iou", "0.45");
    form.append(
      "file",
      new Blob([bgRemovedBuffer], { type: "image/jpeg" }),
      "latest_nobg.jpg"
    );

    // gọi API Ultralytics để chạy AI inference
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

    // lấy kết quả AI
    const result = await res.json();
    const detections = result?.images?.[0]?.results || [];
    console.log("Detections:", detections);

    // lưu kết quả AI vào state chia sẻ
    aiConfig.lastResult = result;
    latestStatus.aiResult = result;
    latestStatus.updatedAt = Date.now();

    console.log("AI inference completed");
  } catch (err) {
    console.error("AI inference failed:", err);
  }
}

export default client;
// export MQTT client để dùng ở nơi khác nếu cần

import express from "express";
import cors from "cors";
// import server HTTP cho frontend

const app = express();
app.use(cors());
app.use(express.json());
// cho phép CORS -> Cho phép frontend ở domain khác được gọi API backend.
// parse JSON body -> Tự động đọc và chuyển body JSON từ request thành req.body.

app.get("/status", (req, res) => {
  // API để frontend lấy trạng thái hiện tại
  res.json({
    ...latestStatus,
    aiEnabled: aiConfig.enabled,
    aiResult: aiConfig.lastResult,
  });
});

app.post("/config/ai", (req, res) => {
  // API bật / tắt AI từ frontend
  const { enabled } = req.body;
  aiConfig.enabled = !!enabled;

  if (!aiConfig.enabled) {
    // tắt AI thì reset kết quả
    aiConfig.lastResult = null;
    latestStatus.aiResult = null;
  }

  if (aiConfig.enabled && !aiInferenceRunning) {
    // bật AI thì chạy inference ngay
    aiInferenceRunning = true;
    runAIInference().finally(() => {
      aiInferenceRunning = false;
    });
  }

  res.json({ ok: true, aiEnabled: aiConfig.enabled });
});

app.post("/decision", async (req, res) => {
  // API cho phép frontend quyết định thủ công ACCEPT / REJECT
  const { decision } = req.body;

  // gửi lệnh xuống ESP32
  client.publish(TOPIC_COMMAND_STATUS, JSON.stringify({ action: decision }), {
    qos: 1,
  });

  // gửi nội dung LCD
  client.publish(
    TOPIC_DISPLAY_LCD,
    JSON.stringify({
      line1: decision === "ACCEPT" ? "Accepted" : "Rejected",
      line2: decision === "REJECT" ? "Prohibited" : "",
    }),
    { qos: 1 }
  );

  // lưu transaction vào backend worker
  await saveTransaction({
    decision,
    weight: latestStatus.weight,
  });
  console.log("Manual decision sent to ESP32:", decision);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("HTTP server listening on port", PORT);
});
