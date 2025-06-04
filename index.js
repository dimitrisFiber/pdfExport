import express from "express";
import createPdf from "./pdf-exporter.mjs";


const app = express();
app.use(express.json());

app.post("/jira-webhook", async (req, res) => {
  console.log("📩 Webhook from Jira:", req.body);
  const issueKey = req.body.issue.key;
  await createPdf(issueKey);
  res.status(200).send("✅ Webhook received");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
