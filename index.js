const express = require("express");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const multer = require("multer");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

// ENV
const {
  OPENAI_API_KEY,
  INSTANTLY_API_KEY,
  APIFY_API_KEY,
  INSTANTLY_CAMPAIGN_ID,
  PORT = 3000
} = process.env;

console.log("✅ Env loaded");

// DATABASE
const dbPath = path.join(__dirname, "leads.db");
const db = new sqlite3.Database(dbPath);

db.run(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    name TEXT,
    company TEXT,
    problem TEXT,
    intent_score INTEGER DEFAULT 0,
    status TEXT DEFAULT 'new',
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    prompt TEXT,
    email1 TEXT,
    followup1 TEXT,
    leads_sent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// QUEUE
let sendQueue = [];
let processing = false;

async function processQueue() {
  if (processing || sendQueue.length === 0) return;
  processing = true;

  while (sendQueue.length > 0) {
    const batch = sendQueue.splice(0, 10);
    try {
      await sendBatch(batch);
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error("Queue error:", err.message);
    }
  }

  processing = false;
}

// SCORING
function scoreLead(text = "") {
  const lower = text.toLowerCase();
  let score = 0;

  const buySignals = ["hire", "paying", "budget", "asap", "urgent", "need"];
  const negativeSignals = ["free", "tutorial", "learn", "student"];

  if (negativeSignals.some(s => lower.includes(s))) return 0;

  buySignals.forEach(signal => {
    if (lower.includes(signal)) score += 20;
  });

  return Math.min(score, 100);
}

// SAVE LEAD
function saveLead(lead) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO leads (email, name, company, problem, intent_score, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        lead.email || "",
        lead.name || "",
        lead.company || "",
        lead.problem || "",
        lead.intent_score || 0,
        lead.source || ""
      ],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

// OPENAI
async function generateEmails(prompt) {
  try {
    if (!OPENAI_API_KEY) {
      return {
        email1: "Hi {{name}}, quick question about {{company}}.",
        followup1: "Just following up on this."
      };
    }

    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "Generate cold email + follow-up. Return ONLY valid JSON with email1 and followup1."
          },
          {
            role: "user",
            content: `Campaign: ${prompt}\nMust include {{name}} and {{company}} placeholders.\nReturn JSON only: {"email1": "...", "followup1": "..."}`
          }
        ],
        temperature: 0.7
      },
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        timeout: 15000
      }
    );

    const text = res?.data?.choices?.[0]?.message?.content || "";
    try {
      return JSON.parse(text);
    } catch {
      return {
        email1: "Hi {{name}}, I help companies like {{company}} with automation.",
        followup1: "Just circling back on this."
      };
    }
  } catch (err) {
    console.error("OpenAI error:", err.message);
    return {
      email1: "Hi {{name}}, quick question about {{company}}.",
      followup1: "Following up."
    };
  }
}

// INSTANTLY
async function sendBatch(batch) {
  if (!INSTANTLY_API_KEY || !INSTANTLY_CAMPAIGN_ID) {
    console.warn("Missing Instantly credentials");
    return;
  }

  const payload = {
    campaign_id: INSTANTLY_CAMPAIGN_ID,
    leads: batch.map(l => ({
      email: l.email,
      first_name: l.name,
      custom_problem: l.problem
    }))
  };

  try {
    await axios.post(
      "https://api.instantly.ai/api/v1/leads",
      payload,
      {
        headers: {
          Authorization: `Bearer ${INSTANTLY_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );

    batch.forEach(l => {
      db.run(`UPDATE leads SET status='sent' WHERE email=?`, [l.email]);
    });

    console.log(`✅ Sent ${batch.length} leads`);
  } catch (err) {
    console.error("Instantly error:", err.message);
  }
}

// APIFY
async function runApifyActor(actorId, input) {
  try {
    if (!APIFY_API_KEY) {
      console.warn("No Apify key");
      return [];
    }

    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_API_KEY}`,
      input,
      { timeout: 30000 }
    );

    const runId = runRes.data?.data?.id;
    if (!runId) return [];

    await new Promise(r => setTimeout(r, 8000));

    const dataRes = await axios.get(
      `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_API_KEY}`,
      { timeout: 15000 }
    );

    return dataRes.data || [];
  } catch (err) {
    console.error("Apify error:", err.message);
    return [];
  }
}

// ROUTES
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/upload-csv", upload.single("file"), async (req, res) => {
  try {
    const leads = [];
    fs.createReadStream(req.file.path)
      .pipe(csv())
      .on("data", data => leads.push(data))
      .on("end", async () => {
        for (const lead of leads) {
          const scored = {
            ...lead,
            intent_score: scoreLead(lead.problem || "")
          };
          await saveLead(scored);
        }
        res.json({ success: true, count: leads.length });
        fs.unlinkSync(req.file.path);
      });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get("/leads", (req, res) => {
  db.all(
    `SELECT * FROM leads ORDER BY created_at DESC LIMIT 100`,
    (err, rows) => {
      if (err) return res.json({ error: err.message });
      res.json({ leads: rows || [] });
    }
  );
});

app.post("/campaign/start", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.json({ error: "No prompt" });

    const emails = await generateEmails(prompt);

    db.all(
      `SELECT * FROM leads WHERE status='new' AND intent_score >= 40 LIMIT 500`,
      async (err, leads) => {
        if (err || !leads || leads.length === 0) {
          return res.json({ error: "No leads found" });
        }

        db.run(
          `INSERT INTO campaigns (name, prompt, email1, followup1, leads_sent)
           VALUES (?, ?, ?, ?, ?)`,
          [
            `Campaign ${Date.now()}`,
            prompt,
            emails.email1,
            emails.followup1,
            leads.length
          ]
        );

        sendQueue.push(...leads);
        processQueue();

        res.json({
          success: true,
          queued: leads.length,
          message: "Campaign queued for sending"
        });
      }
    );
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.post("/scrape", async (req, res) => {
  try {
    const actors = [
      {
        id: "apify/google-search-scraper",
        input: {
          queries: [
            "looking to hire automation expert",
            "need automation asap",
            "paying for automation help"
          ],
          maxPagesPerQuery: 1
        }
      }
    ];

    let totalLeads = 0;

    for (const actor of actors) {
      const results = await runApifyActor(actor.id, actor.input);
      for (const item of results) {
        const lead = {
          email: item.email || `user-${Math.random()}@example.com`,
          name: item.name || "Lead",
          company: item.company || "",
          problem: item.text || "",
          intent_score: scoreLead(item.text || ""),
          source: "apify"
        };

        if (lead.intent_score >= 40) {
          await saveLead(lead);
          totalLeads++;
        }
      }
    }

    res.json({ success: true, leads: totalLeads });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// UI
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Lead Outreach Engine</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial; background: #f5f5f5; padding: 20px; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { color: #333; margin-bottom: 30px; }
    .section { background: white; padding: 20px; margin-bottom: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    h2 { color: #555; font-size: 18px; margin-bottom: 15px; }
    input[type="file"], textarea { width: 100%; padding: 10px; margin-bottom: 10px; border: 1px solid #ddd; border-radius: 4px; font-family: inherit; }
    button { background: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; width: 100%; }
    button:hover { background: #0056b3; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f9f9f9; font-weight: 600; }
    .status { display: inline-block; padding: 4px 8px; border-radius: 3px; font-size: 12px; font-weight: 500; }
    .status.new { background: #fff3cd; color: #856404; }
    .status.sent { background: #d4edda; color: #155724; }
    .message { padding: 10px; margin-bottom: 10px; border-radius: 4px; }
    .message.success { background: #d4edda; color: #155724; }
    .message.error { background: #f8d7da; color: #721c24; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 Lead Outreach Engine</h1>

    <div class="section">
      <h2>📂 Upload CSV</h2>
      <input type="file" id="csvFile" accept=".csv" />
      <button onclick="uploadCSV()">Upload Leads</button>
      <div id="uploadStatus"></div>
    </div>

    <div class="section">
      <h2>✍️ Campaign Prompt</h2>
      <textarea id="prompt" rows="4" placeholder="Describe your outreach campaign..."></textarea>
      <button onclick="startCampaign()">Start Campaign</button>
      <div id="campaignStatus"></div>
    </div>

    <div class="section">
      <h2>🔍 Leads</h2>
      <button onclick="loadLeads()">Refresh Leads</button>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Company</th>
            <th>Score</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="leadsBody"></tbody>
      </table>
    </div>
  </div>

  <script>
    async function uploadCSV() {
      const file = document.getElementById("csvFile").files[0];
      if (!file) return alert("Select a file");

      const form = new FormData();
      form.append("file", file);

      try {
        const res = await fetch("/upload-csv", { method: "POST", body: form });
        const data = await res.json();
        const msg = document.getElementById("uploadStatus");
        if (data.success) {
          msg.innerHTML = \`<div class="message success">✅ Uploaded \${data.count} leads</div>\`;
          loadLeads();
        } else {
          msg.innerHTML = \`<div class="message error">❌ Error: \${data.error}</div>\`;
        }
      } catch (e) {
        document.getElementById("uploadStatus").innerHTML = '<div class="message error">❌ Upload failed</div>';
      }
    }

    async function startCampaign() {
      const prompt = document.getElementById("prompt").value;
      if (!prompt) return alert("Enter a campaign prompt");

      try {
        const res = await fetch("/campaign/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt })
        });
        const data = await res.json();
        const msg = document.getElementById("campaignStatus");
        if (data.success) {
          msg.innerHTML = \`<div class="message success">✅ Queued \${data.queued} leads for sending</div>\`;
        } else {
          msg.innerHTML = \`<div class="message error">❌ Error: \${data.error}</div>\`;
        }
      } catch (e) {
        document.getElementById("campaignStatus").innerHTML = '<div class="message error">❌ Campaign failed</div>';
      }
    }

    async function loadLeads() {
      try {
        const res = await fetch("/leads");
        const data = await res.json();
        const tbody = document.getElementById("leadsBody");
        tbody.innerHTML = (data.leads || [])
          .map(l => \`
            <tr>
              <td>\${l.name}</td>
              <td>\${l.email}</td>
              <td>\${l.company || "-"}</td>
              <td>\${l.intent_score}</td>
              <td><span class="status \${l.status}">\${l.status}</span></td>
            </tr>
          \`)
          .join("");
      } catch (e) {
        console.error(e);
      }
    }

    loadLeads();
    setInterval(loadLeads, 10000);
  </script>
</body>
</html>
  `);
});

// START
app.listen(PORT, () => {
  console.log(`🚀 Lead Outreach Engine running on port ${PORT}`);
});
