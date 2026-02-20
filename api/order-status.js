export default function handler(req, res) {
  res.status(200).json({
    status: "ok",
    message: "Deucces Order Progress Backend läuft ✅",
    timestamp: new Date().toISOString(),
  });
}
