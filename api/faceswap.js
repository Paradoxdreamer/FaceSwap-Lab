// Vercel serverless proxy for OmegaTech face-swap
// Avoids CORS and returns the real upstream error to the client.

export const config = {
  api: {
    bodyParser: false, // we need raw multipart
  },
};

const MODELS = {
  pro: {
    url: "https://api.omegatech.app/api/tools/faceswap",
    buildForm: (face, target) => {
      const fd = new FormData();
      fd.append("source", face, "face.jpg");
      fd.append("target", target, "target.jpg");
      return fd;
    },
  },
  classic: {
    url: "https://api.omegatech.app/api/ai/Faceawap",
    buildForm: (face, target) => {
      const fd = new FormData();
      fd.append("action", "swap");
      fd.append("faceFile", face, "face.jpg");
      fd.append("sourceFile", target, "target.jpg");
      fd.append("raw", "true");
      return fd;
    },
  },
  deep: {
    url: "https://api.omegatech.app/api/ai/Deepfake",
    buildForm: (face, target) => {
      const fd = new FormData();
      fd.append("action", "swap");
      fd.append("source", face, "face.jpg");
      fd.append("target", target, "target.jpg");
      return fd;
    },
  },
  remaker: {
    url: "https://api.omegatech.app/api/ai/remaker",
    buildForm: (face, target) => {
      const fd = new FormData();
      fd.append("action", "swap");
      fd.append("swap", face, "face.jpg");
      fd.append("target", target, "target.jpg");
      return fd;
    },
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Minimal multipart parser for our two fields
function parseMultipart(buffer, boundary) {
  const parts = {};
  const sep = Buffer.from(`--${boundary}`);
  let start = buffer.indexOf(sep) + sep.length;

  while (start < buffer.length) {
    if (buffer[start] === 45 && buffer[start + 1] === 45) break; // --
    if (buffer[start] === 13) start += 2; // \r\n

    const headerEnd = buffer.indexOf("\r\n\r\n", start);
    if (headerEnd === -1) break;
    const header = buffer.slice(start, headerEnd).toString();
    const nameMatch = /name="([^"]+)"/.exec(header);
    const filenameMatch = /filename="([^"]+)"/.exec(header);
    const nextSep = buffer.indexOf(sep, headerEnd + 4);
    if (nextSep === -1) break;

    let dataEnd = nextSep - 2; // strip trailing \r\n
    if (nameMatch) {
      const name = nameMatch[1];
      const data = buffer.slice(headerEnd + 4, dataEnd);
      parts[name] = {
        data,
        filename: filenameMatch ? filenameMatch[1] : null,
        type: /Content-Type:\s*(\S+)/i.exec(header)?.[1] || "application/octet-stream",
      };
    }
    start = nextSep + sep.length;
  }
  return parts;
}

export default async function handler(req, res) {
  // CORS for the frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = /boundary=(.+)$/i.exec(contentType);
    if (!boundaryMatch) {
      return res.status(400).json({ error: "Expected multipart/form-data" });
    }

    const body = await readBody(req);
    const parts = parseMultipart(body, boundaryMatch[1].trim());

    const facePart = parts.face || parts.source;
    const targetPart = parts.target;
    const modelKey = (parts.model?.data?.toString() || "pro").toLowerCase();

    if (!facePart || !targetPart) {
      return res.status(400).json({
        error: "Missing face or target image",
        received: Object.keys(parts),
      });
    }

    const model = MODELS[modelKey] || MODELS.pro;

    // Build Blob-like objects for FormData (Node 18+)
    const faceBlob = new Blob([facePart.data], { type: facePart.type || "image/jpeg" });
    const targetBlob = new Blob([targetPart.data], { type: targetPart.type || "image/jpeg" });

    const form = model.buildForm(faceBlob, targetBlob);

    const upstream = await fetch(model.url, {
      method: "POST",
      body: form,
      // no extra headers — let fetch set multipart boundary
    });

    const ct = upstream.headers.get("content-type") || "";

    if (!upstream.ok) {
      let detail = "";
      try {
        detail = await upstream.text();
      } catch {}
      // Try to parse JSON error from OmegaTech
      let parsed = null;
      try {
        parsed = JSON.parse(detail);
      } catch {}

      return res.status(upstream.status).json({
        error: parsed?.error || parsed?.message || `Upstream ${upstream.status}`,
        details: parsed || detail.slice(0, 500),
        model: modelKey,
        source: "omegatech",
      });
    }

    // Success — could be raw image or JSON with base64/url
    if (ct.includes("application/json")) {
      const json = await upstream.json();
      const b64 =
        json.image || json.result || json.base64 || json.data?.image || json.output;
      if (b64 && typeof b64 === "string") {
        const pure = b64.replace(/^data:image\/\w+;base64,/, "");
        const buf = Buffer.from(pure, "base64");
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).send(buf);
      }
      if (json.url || json.image_url) {
        const imgRes = await fetch(json.url || json.image_url);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        res.setHeader("Content-Type", imgRes.headers.get("content-type") || "image/jpeg");
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).send(buf);
      }
      return res.status(502).json({
        error: "Unexpected JSON response from upstream",
        details: json,
        model: modelKey,
      });
    }

    // Raw image
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", ct.includes("image") ? ct : "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buf);
  } catch (err) {
    console.error("[faceswap proxy]", err);
    return res.status(500).json({
      error: err.message || "Proxy failure",
      source: "proxy",
    });
  }
}
