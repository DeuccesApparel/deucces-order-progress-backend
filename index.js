import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.send("Deucces Order Progress Backend läuft ✅");
});

app.get("/apps/order-status", (req, res) => {
  res.send({
    status: "ok",
    message: "Order Progress Endpoint erreichbar",
    timestamp: new Date().toISOString(),
  });
});

export default app;
