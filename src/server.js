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
const mockupPath = path.join(publicDir, 'raphinha.png');
const regularFontPath = path.join(publicDir, 'fonts', 'LiberationSans-Regular.ttf');
const boldFontPath = path.join(publicDir, 'fonts', 'LiberationSans-Bold.ttf');
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
  Janeiro: '01', Fevereiro: '02', Março: '03', Abril: '04',
  Maio: '05', Junho: '06', Julho: '07', Agosto: '08',
  Setembro: '09', Outubro: '10', Novembro: '11', Dezembro: '12'
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
      regularFont: fs.existsSync(regularFontPath),
      boldFont: fs.existsSync(boldFontPath)
    },
    runtime: { vercel: isVercel, node: process.version },
    time: new Date().toISOString()
  });
});

app.get('/api/stickers/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) { res.status(404).json({ error: 'Figurinha nao encontrada.' }); return; }
  res.json(job);
});

app.post('/api/stickers', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'Envie a foto do craque.' }); return; }

    const data = normalizePayload(req.body);
    const missing = requiredFields.filter(field => !data[field]);
    if (missing.length) { res.status(400).json({ error: `Campos obrigatorios: ${missing.join(', ')}.` }); return; }

    const id = crypto.randomUUID();
    const originalPath = path.join(runtimeDir, `${id}-original.png`);
    const faceCropPath = path.join(runtimeDir, `${id}-face-crop.png`);
    const faceResultPath = path.join(runtimeDir, `${id}-face-result.png`);
    const stickerPath = path.join(outputDir, `${id}.png`);

    // 1. Salvar foto do usuário
    await sharp(req.file.buffer)
      .rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toFile(originalPath);

    // 2. Obter metadados do mockup para calibrar posições
    const mockupMeta = await sharp(mockupPath).metadata();
    const mockupWidth = mockupMeta.width;
    const mockupHeight = mockupMeta.height;

    // 3. Recortar APENAS a área do rosto do mockup (região fixa do rosto)
    // Raphinha.png: rosto fica aproximadamente em 30-50% horizontal, 8-28% vertical
    const faceRegion = {
      left: Math.round(mockupWidth * 0.28),
      top: Math.round(mockupHeight * 0.06),
      width: Math.round(mockupWidth * 0.44),
      height: Math.round(mockupHeight * 0.32)
    };

    await sharp(mockupPath)
      .extract(faceRegion)
      .png()
      .toFile(faceCropPath);

    // 4. Gerar novo rosto usando OpenAI (APENAS o rosto, não o corpo)
    const sourcePlayerPath = await generateFaceOnly(
      originalPath,
      faceCropPath,
      faceResultPath,
      data
    );

    // 5. Compor figurinha: colar rosto modificado de volta no mockup + textos
    const stickerBuffer = await composeSticker({
      id,
      data,
      faceResultPath: sourcePlayerPath,
      faceRegion,
      mockupWidth,
      mockupHeight
    });

    const imageDataUrl = `data:image/png;base64,${stickerBuffer.toString('base64')}`;
    if (!isVercel) await fsp.writeFile(stickerPath, stickerBuffer);

    const job = {
      id,
      status: 'done',
      imageUrl: isVercel ? '' : `/output/${id}.png`,
      imageDataUrl,
      usedOpenAI: sourcePlayerPath === faceCropPath,
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
    console.log(`  Mockup: raphinha.png (${mockupPath})`);
    console.log(`  HTML principal: ${path.join(publicDir, 'index.html')}\n`);
  });
}

// =====================================================================
// FUNÇÕES
// =====================================================================

function normalizePayload(body) {
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key, String(value || '').trim()])
  );
}

// Troca APENAS o rosto - edita somente a região recortada
async function generateFaceOnly(sourcePath, faceCropPath, outputPath, data) {
  const canUseOpenAI = process.env.OPENAI_API_KEY && process.env.OPENAI_GENERATION_ENABLED === 'true';
  if (!canUseOpenAI) return faceCropPath; // Sem OpenAI, retorna crop original

  await assertReadable(sourcePath, 'SOURCE_IMAGE_MISSING');
  await assertReadable(faceCropPath, 'FACE_CROP_MISSING');

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Upload da foto do usuário (referência de identidade)
  const sourceUpload = await toFile(
    await fsp.readFile(sourcePath),
    'face-reference.png',
    { type: 'image/png' }
  );

  // Upload do rosto recortado do mockup (região a ser editada)
  const faceCropUpload = await toFile(
    await fsp.readFile(faceCropPath),
    'face-to-replace.png',
    { type: 'image/png' }
  );

  // Prompt CIRÚRGICO - troca APENAS o rosto
  const surgicalPrompt = `CIRGURICAL FACE SWAP TASK - VERY IMPORTANT RULES:

INPUT: Two images.
Image 1 (face-reference.png): A photo of a person - use ONLY for face identity.
Image 2 (face-to-replace.png): A cropped face region from a football sticker.

YOUR TASK:
1. Look at the FACE in Image 1 (reference) - note the identity, features, skin tone.
2. Look at Image 2 (the crop) - this is the TARGET region.
3. REPLACE the face in Image 2 with the face identity from Image 1.
4. KEEP the EXACT same:
   - Head angle and pose from Image 2
   - Lighting direction and intensity from Image 2  
   - Skin tone MATCHED to Image 2's surrounding skin
   - Hair style from Image 2 (do NOT import hair from Image 1)
   - Background color/gradient from Image 2
   - Image dimensions of Image 2

CRITICAL CONSTRAINTS:
- Output MUST have EXACTLY the same dimensions as Image 2
- Output MUST keep the EXACT same background as Image 2
- ONLY the facial features (eyes, nose, mouth, cheeks) should change
- Do NOT add any text, borders, frames, or decorations
- Do NOT change the head shape or angle
- Blend edges seamlessly so no seam is visible
- The face should look like it naturally belongs in the sticker

This is for a collectible football sticker. The result must look professional and seamless.`;

  const response = await client.images.edit({
    model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5',
    image: [sourceUpload, faceCropUpload],
    prompt: surgicalPrompt,
    size: '1024x1024',
    quality: process.env.OPENAI_IMAGE_QUALITY || 'medium',
    n: 1
  });

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error('A API da OpenAI nao retornou a imagem em base64.');
  await fsp.writeFile(outputPath, Buffer.from(b64, 'base64'));
  return outputPath;
}

// Compor figurinha: mockup original + rosto modificado + textos
async function composeSticker({ id, data, faceResultPath, faceRegion, mockupWidth, mockupHeight }) {
  await assertReadable(mockupPath, 'MOCKUP_MISSING');
  await assertReadable(faceResultPath, 'FACE_RESULT_MISSING');

  const width = mockupWidth;
  const height = mockupHeight;

  // Posições dos textos (percentuais do mockup raphinha.png)
  const nameBar = box(width, height, {
    left: 0.04,
    top: 0.80,
    width: 0.92,
    height: 0.07
  });

  const detailsBar = box(width, height, {
    left: 0.04,
    top: 0.86,
    width: 0.92,
    height: 0.05
  });

  const clubBar = box(width, height, {
    left: 0.04,
    top: 0.91,
    width: 0.92,
    height: 0.06
  });

  // Redimensionar o rosto modificado para caber exatamente na região recortada
  const fittedFace = await sharp(faceResultPath)
    .resize(faceRegion.width, faceRegion.height, {
      fit: 'fill',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();

  // Criar máscara de blend suave nas bordas do rosto
  const blendMask = await sharp({
    create: {
      width: faceRegion.width,
      height: faceRegion.height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 255 }
    }
  })
    .blur(3)
    .png()
    .toBuffer();

  // Aplicar máscara de blend no rosto
  const blendedFace = await sharp(fittedFace)
    .composite([
      {
        input: blendMask,
        blend: 'dest-in'
      }
    ])
    .png()
    .toBuffer();

  // Gerar SVG com textos
  const svgContent = buildStickerSvg({ id, data, width, height, nameBar, detailsBar, clubBar });

  // Compor tudo: mockup + rosto modificado + textos
  return sharp(mockupPath)
    .ensureAlpha()
    .composite([
      {
        input: blendedFace,
        left: faceRegion.left,
        top: faceRegion.top,
        blend: 'over'
      },
      {
        input: Buffer.from(svgContent),
        left: 0,
        top: 0
      }
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function buildStickerSvg({ id, data, width, height, nameBar, detailsBar, clubBar }) {
  const birthDate = `${data.dia}-${months[data.mes] || data.mes}-${data.ano}`;
  const heightMeters = (Number(data.altura) / 100).toFixed(2).replace('.', ',');
  const safeName = escapeXml(data.nome.toUpperCase()).slice(0, 26);
  const safeClub = escapeXml(data.clube.toUpperCase()).slice(0, 32);
  const details = escapeXml(`${birthDate} | ${heightMeters}m | ${data.peso}kg`);
  const watermark = escapeXml(
    process.env.WATERMARK_TEXT || 'PREVIEW PROTEGIDO - DIREITOS AUTORAIS'
  );
  const jobMark = escapeXml(id.slice(0, 8).toUpperCase());

  // Linhas de marca d'água diagonais
  const wmLines = Array.from({ length: 18 }, (_, row) => {
    const y = Math.round(-height * 0.15 + row * height * 0.085);
    return `<text x="${Math.round(-width * 0.6)}" y="${y}" class="wm">${watermark} • ${jobMark}</text>`;
  }).join('');

  const regularFont = fontDataUri(regularFontPath);
  const boldFont = fontDataUri(boldFontPath);

  const fontSize = {
    name: Math.round(height * 0.052),
    details: Math.round(height * 0.026),
    club: Math.round(height * 0.030),
    wm: Math.round(height * 0.028),
    wmSmall: Math.round(height * 0.018)
  };

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          @font-face { font-family: "StickerFont"; src: url("${regularFont}") format("truetype"); font-weight: 400; }
          @font-face { font-family: "StickerFont"; src: url("${boldFont}") format("truetype"); font-weight: 700; }
        </style>
      </defs>

      <!-- Marca d'água diagonal -->
      <g transform="rotate(-25 ${width / 2} ${height / 2})">${wmLines}</g>

      <!-- Nome do jogador -->
      <text 
        x="${nameBar.left + nameBar.width / 2}" 
        y="${nameBar.top + nameBar.height * 0.65}" 
        font-family="StickerFont, sans-serif" 
        font-size="${fontSize.name}px" 
        font-weight="700" 
        fill="#FFFFFF" 
        text-anchor="middle" 
        letter-spacing="2px"
      >${safeName}</text>

      <!-- Detalhes: data | altura | peso -->
      <text 
        x="${detailsBar.left + detailsBar.width / 2}" 
        y="${detailsBar.top + detailsBar.height * 0.65}" 
        font-family="StickerFont, sans-serif" 
        font-size="${fontSize.details}px" 
        font-weight="400" 
        fill="#FFFFFF" 
        text-anchor="middle" 
        letter-spacing="1px"
        opacity="0.9"
      >${details}</text>

      <!-- Clube -->
      <text 
        x="${clubBar.left + clubBar.width / 2}" 
        y="${clubBar.top + clubBar.height * 0.65}" 
        font-family="StickerFont, sans-serif" 
        font-size="${fontSize.club}px" 
        font-weight="700" 
        fill="#FFFFFF" 
        text-anchor="middle" 
        letter-spacing="1.5px"
      >${safeClub}</text>

      <!-- Marca d'água small -->
      <text 
        x="${width * 0.5}" 
        y="${height * 0.72}" 
        font-family="StickerFont, sans-serif" 
        font-size="${fontSize.wmSmall}px" 
        font-weight="700" 
        fill="rgba(255,255,255,0.6)" 
        text-anchor="middle" 
        transform="rotate(-25 ${width * 0.5} ${height * 0.72})"
        letter-spacing="1px"
      >PREVIEW • ${jobMark}</text>
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

function fontDataUri(filePath) {
  const data = fs.readFileSync(filePath).toString('base64');
  return `data:font/truetype;base64,${data}`;
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
  return { code, status, requestId, message: error?.message || 'Unknown error' };
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
