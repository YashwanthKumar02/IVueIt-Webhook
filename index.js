// index.js
require('dotenv').config();
const os = require('node:os');
const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');

const app = express();

// ---------- Config ----------
const PORT = Number(process.env.PORT || 3000);
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

const AXIOS_TIMEOUT_MS = Number(process.env.AXIOS_TIMEOUT_MS || 15000);
const SLACK_MAX_RETRIES = Number(process.env.SLACK_MAX_RETRIES || 3);
const MAX_CODEBLOCK_CHARS = Number(process.env.MAX_CODEBLOCK_CHARS || 30000); // large but bounded
const MAX_TOTAL_MESSAGE_BYTES = Number(process.env.MAX_TOTAL_MESSAGE_BYTES || 30000);

if (!SLACK_WEBHOOK_URL) {
  console.error('Missing SLACK_WEBHOOK_URL in env. Set SLACK_WEBHOOK_URL to a Slack incoming webhook URL.');
  process.exit(1);
}

// ---------- Helpers ----------
function safeTruncateString(str, maxChars) {
  if (!str) return str;
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars - 24) + '\n\n... (truncated) ...';
}

function escapeTripleBackticks(s) {
  return String(s).replace(/```/g, "'''");
}

function safeJsonStringify(obj, maxChars = MAX_CODEBLOCK_CHARS) {
  try {
    const j = JSON.stringify(obj, null, 2);
    return safeTruncateString(j, maxChars);
  } catch (err) {
    const fallback = String(obj);
    return safeTruncateString(fallback, maxChars);
  }
}

// ---------- Formatter (JS port of your TS example) ----------
class EventProcessingErrorFormatter {
  constructor(data = {}, eventType = null) {
    this.hostName = os.hostname();
    this.data = data;
    this.eventType = eventType;
  }

  build() {
    const { additional_info } = this.data ?? {};
    const req = additional_info?.req ?? {};

    const lines = [
      '*---------------------------- IVueIt WebHook Notification ----------------------------*',
      ...(req?.url ? [`\n*URL:*\n\`${req.url}\``] : []),
      ...(req?.method ? [`\n*Method:*\n\`${req.method}\``] : []),
      ...(req?.body
        ? [`\n*Request Body:*\n\`\`\`json\n${safeJsonStringify(req.body)}\n\`\`\``]
        : []),
      `\n*Hostname:*\n\`${this.hostName}\``,
      `\n*Event:*\n\`${this.eventType}\``
    ];

    const formattedDetails = {};

    if (this.data?.company?.id) {
      formattedDetails.company = {
        id: this.data.company.id,
        name: this.data.company.name ?? 'N/A'
      };
    }

    if (this.data?.user?.id) {
      formattedDetails.user = {
        id: this.data.user.id,
        first_name: this.data.user.first_name ?? '',
        last_name: this.data.user.last_name ?? '',
        full_name: this.data.user.full_name ?? 'N/A'
      };
    }

    // Compose Slack-compatible payload: text + attachments (legacy but widely supported)
    const text = lines.join('\n\n');

    return { text };
  }

  isProd() {
    // Consider NODE_ENV === 'production' as prod
    return String(this.environment).toLowerCase() === 'production';
  }
}

// ---------- Axios with keepAlive + retries ----------
const axiosInstance = axios.create({
  timeout: AXIOS_TIMEOUT_MS,
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true })
});

async function postToSlack(body) {
  let attempt = 0;
  let delay = 500;
  while (attempt < SLACK_MAX_RETRIES) {
    attempt++;
    try {
      const resp = await axiosInstance.post(SLACK_WEBHOOK_URL, body, {
        headers: { 'Content-Type': 'application/json' }
      });
      return { ok: true, status: resp.status, data: resp.data };
    } catch (err) {
      // Log details for diagnosis
      if (err.response) {
        console.error('Slack responded with status:', err.response.status);
        console.error('Slack response body:', err.response.data);
      } else if (err.request) {
        console.error('No response from Slack. error:', err.message);
      } else {
        console.error('Axios error:', err.message);
      }

      if (attempt >= SLACK_MAX_RETRIES) {
        return { ok: false, error: err };
      }
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

// ---------- Build a Slack body that includes the formatter's output and full payload code block ----------
function buildSlackBodyFromFormatterAndPayload(formatterResult, fullPayload) {
  // The webhook expects a JSON object containing text and attachments.
  // We'll include full payload within the text as a code block (safe-truncated).
  const safeFullPayload = safeJsonStringify(fullPayload, MAX_CODEBLOCK_CHARS);

  // Combine formatter text and payload
  const text = [
    formatterResult.text,
    '\n\n*Payload:*',
    '```json',
    safeFullPayload,
    '```'
  ].join('\n\n');

  // Using attachments as in formatterResult.attachments
  return {
    text,
    attachments: formatterResult.attachments
  };
}

app.post('/webhook/vue-completed', (req, res) => {
  const incoming = req.body;

  // Respond fast
  res.status(202).json({ status: 'accepted' });

  // Asynchronously build message and send to Slack
  (async () => {
    try {
      const formatter = new EventProcessingErrorFormatter(incoming, 'Vue Completed');
      const formatted = formatter.build();
      const slackBody = buildSlackBodyFromFormatterAndPayload(formatted, incoming);

      // quick size check: if result is huge, truncate full payload further
      const approxBytes = Buffer.byteLength(JSON.stringify(slackBody), 'utf8');
      if (approxBytes > MAX_TOTAL_MESSAGE_BYTES) {
        // shrink payload area more aggressively
        slackBody.text = slackBody.text.replace(/```json[\s\S]*```/, '```json\n... (payload truncated due to size) ...\n```');
      }

      const result = await postToSlack(slackBody);
      if (!result.ok) {
        console.error('Failed to post to Slack after retries.', result.error || '');
      } else {
        console.log('Slack post OK:', result.status);
      }
    } catch (err) {
      console.error('Unhandled error while formatting/sending to Slack:', err);
    }
  })();
});

app.post('/webhook/vue-cancelled', (req, res) => {
  const incoming = req.body;

  console.log(req);

  console.log(JSON.parse(req));

  // Respond fast
  res.status(202).json({ status: 'accepted' });

  // // Asynchronously build message and send to Slack
  // (async () => {
  //   try {
  //     const formatter = new EventProcessingErrorFormatter(incoming, 'Vue Cancelled');
  //     const formatted = formatter.build();
  //     const slackBody = buildSlackBodyFromFormatterAndPayload(formatted, incoming);

  //     // quick size check: if result is huge, truncate full payload further
  //     const approxBytes = Buffer.byteLength(JSON.stringify(slackBody), 'utf8');
  //     if (approxBytes > MAX_TOTAL_MESSAGE_BYTES) {
  //       // shrink payload area more aggressively
  //       slackBody.text = slackBody.text.replace(/```json[\s\S]*```/, '```json\n... (payload truncated due to size) ...\n```');
  //     }

  //     const result = await postToSlack(slackBody);
  //     if (!result.ok) {
  //       console.error('Failed to post to Slack after retries.', result.error || '');
  //     } else {
  //       console.log('Slack post OK:', result.status);
  //     }
  //   } catch (err) {
  //     console.error('Unhandled error while formatting/sending to Slack:', err);
  //   }
  // })();
});

// simple health and test endpoints
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.get('/test-slack', async (req, res) => {
  const sample = {
    additional_info: {
      req: {
        url: '/test-slack',
        method: 'GET',
        body: { sample: true }
      },
      error: new Error('This is a test error')
    },
    company: { id: 123, name: 'Acme Co' },
    user: { id: 999, first_name: 'Test', last_name: 'User', full_name: 'Test User' }
  };

  const formatter = new EventProcessingErrorFormatter(sample);
  const formatted = formatter.build();
  const body = buildSlackBodyFromFormatterAndPayload(formatted, sample);

  const result = await postToSlack(body);
  if (result.ok) return res.status(200).json({ ok: true, status: result.status });
  return res.status(500).json({ ok: false, error: String(result.error?.message || result.error) });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
