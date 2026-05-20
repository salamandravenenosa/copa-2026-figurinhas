import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import express from 'express';
import multer from 'multer';
import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const isVercel = Boolean(process.env.VERCEL);
const PORT = Number(process.env.PORT) || 3100;
const publicDir = path.join(__dirname, '..', 'public');
const uploadDir = path.join(publicDir, 'uploads');
const outputDir = path.join(publicDir, 'output');
const runtimeDir = isVercel ? path.join('/tmp', 'figurinha-copa') : outputDir;
const mockupPath = path.join(publicDir, 'figurinha-brasil.jpg');
const shirtReferencePath = path.join(publicDir, 'brasil-camisa.jpg');
const jobs = new Map();
const isProduction = process.env.NODE_ENV === 'production';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      cb(new Error('Envie uma imagem valida.'));
      return;
    }
    cb(null, true);
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));

await Promise.all([
  fsp.mkdir(runtimeDir, { recursive: true }),
  fsp.mkdir(uploadDir, { recursive: true }).catch(() => undefined),
  fsp.mkdir(outputDir, { recursive: true }).catch(() => undefined)
]);

const requiredFields = ['nome', 'email', 'dia', 'mes', 'ano', 'clube', 'peso', 'altura'];
const months = {
  Janeiro: '01',
  Fevereiro: '02',
  Março: '03',
  Abril: '04',
  Maio: '05',
  Junho: '06',
  Julho: '07',
  Agosto: '08',
  Setembro: '09',
  Outubro: '10',
  Novembro: '11',
  Dezembro: '12'
};

app.get(['/health', '/api/health'], (_req, res) => {
  res.json({
    ok: true,
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    openaiGenerationEnabled: process.env.OPENAI_GENERATION_ENABLED === 'true',
    openaiImageModel: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5',
    openaiImageQuality: process.env.OPENAI_IMAGE_QUALITY || 'medium',
    assets: {
      mockup: fs.existsSync(mockupPath),
      shirtReference: fs.existsSync(shirtReferencePath)
    },
    runtime: {
      vercel: isVercel,
      node: process.version
    },
    time: new Date().toISOString()
  });
});

app.get('/api/stickers/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Figurinha nao encontrada.' });
    return;
  }
  res.json(job);
});

app.post('/api/stickers', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Envie a foto do craque.' });
      return;
    }

    const data = normalizePayload(req.body);
    const missing = requiredFields.filter(field => !data[field]);
    if (missing.length) {
      res.status(400).json({ error: `Campos obrigatorios: ${missing.join(', ')}.` });
      return;
    }

    const id = crypto.randomUUID();
    const originalPath = path.join(runtimeDir, `${id}-original.png`);
    const playerPath = path.join(runtimeDir, `${id}-player.png`);
    const stickerPath = path.join(outputDir, `${id}.png`);

    await sharp(req.file.buffer)
      .rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toFile(originalPath);

    const sourcePlayerPath = await generatePlayerImage(originalPath, playerPath, data);
    const stickerBuffer = await composeSticker({
      id,
      data,
      playerPath: sourcePlayerPath
    });
    const imageDataUrl = `data:image/png;base64,${stickerBuffer.toString('base64')}`;
    if (!isVercel) await fsp.writeFile(stickerPath, stickerBuffer);

    const job = {
      id,
      status: 'done',
      imageUrl: isVercel ? '' : `/output/${id}.png`,
      imageDataUrl,
      usedOpenAI: sourcePlayerPath === playerPath,
      createdAt: new Date().toISOString()
    };
    jobs.set(id, job);
    res.status(201).json(job);
  } catch (error) {
    const normalized = normalizeError(error);
    console.error('Sticker generation failed:', normalized);
    res.status(500).json({
      error: 'Nao foi possivel gerar a figurinha agora.',
      code: normalized.code,
      requestId: normalized.requestId,
      detail: isProduction ? undefined : normalized.message
    });
  }
});

app.use((error, _req, res, _next) => {
  res.status(400).json({ error: error.message || 'Requisicao invalida.' });
});

if (!isVercel) {
  app.listen(PORT, () => {
    console.log(`\n  Figurinha Copa rodando em http://localhost:${PORT}`);
    console.log(`  OpenAI gera imagens: ${process.env.OPENAI_GENERATION_ENABLED === 'true' ? 'sim' : 'nao'}`);
    console.log(`  HTML principal: ${path.join(publicDir, 'index.html')}\n`);
  });
}

function normalizePayload(body) {
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key, String(value || '').trim()])
  );
}

async function generatePlayerImage(originalPath, outputPath, data) {
  const canUseOpenAI = process.env.OPENAI_API_KEY && process.env.OPENAI_GENERATION_ENABLED === 'true';
  if (!canUseOpenAI) return originalPath;
  await assertReadable(originalPath, 'SOURCE_IMAGE_MISSING');
  await assertReadable(shirtReferencePath, 'SHIRT_REFERENCE_MISSING');

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const sourceUpload = await toFile(
    await fsp.readFile(originalPath),
    'source.png',
    { type: 'image/png' }
  );
  const shirtReferencePng = await sharp(shirtReferencePath)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const shirtUpload = await toFile(
    shirtReferencePng,
    'brasil-camisa.png',
    { type: 'image/png' }
  );
  const prompt = [
    'Use the first image only as identity reference for the person face. Do not reuse the original photo background.',
    'Create a clean collectible football sticker player portrait, like a World Cup sticker.',
    'Keep the same face identity, hair, skin tone, age impression and expression from the uploaded person.',
    'Use the second image as the official Brazil shirt reference: yellow Brazil football jersey, green collar/details, crest placement and athletic pose.',
    'The output must be a single person only, from thighs or waist up, centered, crisp edges, transparent background.',
    'No room, no furniture, no outdoor background, no text outside the jersey, no watermark.',
    `Player name for context: ${data.nome}. Club for context: ${data.clube}.`
  ].join(' ');

  const response = await client.images.edit({
    model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5',
    image: [sourceUpload, shirtUpload],
    prompt,
    background: 'transparent',
    size: '1024x1024',
    quality: process.env.OPENAI_IMAGE_QUALITY || 'medium',
    n: 1
  });

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error('A API da OpenAI nao retornou a imagem em base64.');
  await fsp.writeFile(outputPath, Buffer.from(b64, 'base64'));
  return outputPath;
}

async function composeSticker({ id, data, playerPath }) {
  await assertReadable(mockupPath, 'MOCKUP_MISSING');
  await assertReadable(playerPath, 'PLAYER_IMAGE_MISSING');
  const poster = await sharp(mockupPath).metadata();
  const width = poster.width || 735;
  const height = poster.height || 956;
  const playerBox = box(width, height, {
    left: 0.07,
    top: 0.33,
    width: 0.53,
    height: 0.52
  });
  const nameBar = box(width, height, {
    left: 0.052,
    top: 0.833,
    width: 0.714,
    height: 0.067
  });
  const clubBar = box(width, height, {
    left: 0.052,
    top: 0.941,
    width: 0.62,
    height: 0.043
  });

  const fittedPlayer = await sharp(playerPath)
    .rotate()
    .resize(playerBox.width, playerBox.height, {
      fit: 'contain',
      position: 'south',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();
  const fittedMeta = await sharp(fittedPlayer).metadata();
  const player = await sharp({
    create: {
      width: playerBox.width,
      height: playerBox.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([
      {
        input: fittedPlayer,
        left: Math.max(0, Math.round((playerBox.width - (fittedMeta.width || playerBox.width)) / 2)),
        top: Math.max(0, playerBox.height - (fittedMeta.height || playerBox.height))
      }
    ])
    .png()
    .toBuffer();

  const overlays = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([
      {
        input: Buffer.from(buildStickerSvg({ id, data, width, height, nameBar, clubBar })),
        left: 0,
        top: 0
      }
    ])
    .png()
    .toBuffer();

  return sharp(mockupPath)
    .ensureAlpha()
    .composite([
      { input: player, left: playerBox.left, top: playerBox.top },
      { input: overlays, left: 0, top: 0 }
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function buildStickerSvg({ id, data, width, height, nameBar, clubBar }) {
  const birthDate = `${data.dia}-${months[data.mes] || data.mes}-${data.ano}`;
  const heightMeters = (Number(data.altura) / 100).toFixed(2).replace('.', ',');
  const safeName = escapeXml(data.nome.toUpperCase()).slice(0, 26);
  const safeClub = escapeXml(data.clube.toUpperCase()).slice(0, 32);
  const details = escapeXml(`${birthDate} | ${heightMeters} | ${data.peso}kg`);
  const watermark = escapeXml(
    process.env.WATERMARK_TEXT ||
    'ESTA FIGURINHA TEM DIREITOS AUTORAIS - PREVIEW PROTEGIDO - NAO COPIAR'
  );
  const jobMark = escapeXml(id.slice(0, 8).toUpperCase());
  const wmLines = Array.from({ length: 16 }, (_, row) => {
    const y = Math.round(-height * 0.15 + row * height * 0.092);
    return `<text x="${Math.round(-width * 0.55)}" y="${y}" class="wm">${watermark} - ${jobMark} - ${watermark}</text>`;
  }).join('');
  const wmReverseLines = Array.from({ length: 12 }, (_, row) => {
    const y = Math.round(-height * 0.08 + row * height * 0.12);
    return `<text x="${Math.round(-width * 0.45)}" y="${y}" class="wmAlt">${watermark} - USO NAO AUTORIZADO - ${jobMark}</text>`;
  }).join('');

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <style>
        .name { font: 800 ${Math.round(height * 0.049)}px Arial, sans-serif; fill: #fff; letter-spacing: 1.5px; }
        .details { font: 400 ${Math.round(height * 0.029)}px Arial, sans-serif; fill: #fff; letter-spacing: .6px; }
        .club { font: 500 ${Math.round(height * 0.028)}px Arial, sans-serif; fill: #fff; letter-spacing: .8px; }
        .wm { font: 900 ${Math.round(height * 0.030)}px Arial, sans-serif; fill: rgba(255,255,255,.42); letter-spacing: 3px; }
        .wmAlt { font: 900 ${Math.round(height * 0.023)}px Arial, sans-serif; fill: rgba(0,0,0,.24); letter-spacing: 2px; }
        .wmSmall { font: 900 ${Math.round(height * 0.022)}px Arial, sans-serif; fill: rgba(255,255,255,.72); letter-spacing: 2px; }
      </style>
      <g transform="rotate(-28 ${width / 2} ${height / 2})">${wmLines}</g>
      <g transform="rotate(24 ${width / 2} ${height / 2})">${wmReverseLines}</g>
      <text x="${nameBar.left + nameBar.width / 2}" y="${nameBar.top + nameBar.height * 0.50}" class="name" text-anchor="middle">${safeName}</text>
      <text x="${nameBar.left + nameBar.width / 2}" y="${nameBar.top + nameBar.height * 0.88}" class="details" text-anchor="middle">${details}</text>
      <text x="${clubBar.left + clubBar.width / 2}" y="${clubBar.top + clubBar.height * 0.70}" class="club" text-anchor="middle">${safeClub}</text>
      <text x="${width * 0.49}" y="${height * 0.70}" class="wmSmall" text-anchor="middle" transform="rotate(-28 ${width * 0.49} ${height * 0.70})">PREVIEW COM DIREITOS AUTORAIS - ${jobMark}</text>
    </svg>
  `;
}

function box(width, height, ratio) {
  return {
    left: Math.round(width * ratio.left),
    top: Math.round(height * ratio.top),
    width: Math.round(width * ratio.width),
    height: Math.round(height * ratio.height)
  };
}

async function assertReadable(filePath, code) {
  try {
    await fsp.access(filePath, fs.constants.R_OK);
  } catch {
    const error = new Error(`${code}: ${filePath}`);
    error.code = code;
    throw error;
  }
}

function normalizeError(error) {
  const status = error?.status || error?.response?.status;
  const requestId = error?.request_id || error?.requestID || error?.headers?.['x-request-id'];
  let code = error?.code || error?.type || 'GENERATION_FAILED';
  if (status === 401) code = 'OPENAI_AUTH_FAILED';
  if (status === 402 || /billing|quota|credit/i.test(error?.message || '')) code = 'OPENAI_BILLING_OR_QUOTA';
  if (status === 429) code = 'OPENAI_RATE_LIMIT';
  if (status >= 500) code = 'OPENAI_UPSTREAM_ERROR';

  return {
    code,
    status,
    requestId,
    message: error?.message || 'Unknown error'
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export default app;
