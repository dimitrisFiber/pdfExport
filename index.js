import express from "express";

const app = express();
app.use(express.json());

app.post("/jira-webhook", (req, res) => {
  console.log("📩 Webhook from Jira:", req.body);
  res.status(200).send("✅ Webhook received");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
