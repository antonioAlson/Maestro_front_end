import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { query } from '../config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── GET /api/quality ────────────────────────────────────────────────────────
export const listCertificates = async (req, res) => {
  const { search = '', limit = 50, offset = 0 } = req.query;
  try {
    const params = [];
    let where = '';
    if (search.trim()) {
      params.push(`%${search.trim()}%`);
      where = `WHERE (c.numero ILIKE $1 OR c.veiculo ILIKE $1 OR c.nota_fiscal ILIKE $1 OR c.certificado ILIKE $1)`;
    }
    params.push(Number(limit), Number(offset));
    const li = params.length - 1;
    const oi = params.length;

    const { rows } = await query(
      `SELECT c.*, u.name AS created_by_name
       FROM maestro.quality_certificates c
       LEFT JOIN maestro.users u ON u.id = c.created_by
       ${where}
       ORDER BY c.created_at DESC
       LIMIT $${li} OFFSET $${oi}`,
      params
    );

    const countParams = search.trim() ? [`%${search.trim()}%`] : [];
    const countWhere = search.trim()
      ? `WHERE (numero ILIKE $1 OR veiculo ILIKE $1 OR nota_fiscal ILIKE $1 OR certificado ILIKE $1)`
      : '';
    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM maestro.quality_certificates ${countWhere}`,
      countParams
    );

    return res.json({ success: true, data: rows, total: Number(countRows[0].count) });
  } catch (err) {
    console.error('[Quality] listCertificates error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET /api/quality/:id ─────────────────────────────────────────────────────
export const getCertificate = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT c.*, u.name AS created_by_name
       FROM maestro.quality_certificates c
       LEFT JOIN maestro.users u ON u.id = c.created_by
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Certificado não encontrado' });
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[Quality] getCertificate error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── POST /api/quality ────────────────────────────────────────────────────────
export const createCertificate = async (req, res) => {
  const {
    numero, certificado, paineis_balisticos, produtos, nota_fiscal,
    veiculo, data_emissao, material, norma, nivel,
    certificados_conformidade, garantia_anos,
  } = req.body;

  if (!numero) return res.status(400).json({ success: false, message: '"numero" é obrigatório.' });

  try {
    const { rows } = await query(
      `INSERT INTO maestro.quality_certificates
         (numero, certificado, paineis_balisticos, produtos, nota_fiscal, veiculo,
          data_emissao, material, norma, nivel, certificados_conformidade, garantia_anos, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        numero, certificado, paineis_balisticos,
        JSON.stringify(produtos || []),
        nota_fiscal, veiculo, data_emissao || null,
        material || 'Dupont Kevlar® S745GR',
        norma || 'ABNT NBR 15000:2020-2',
        nivel || 'III-A',
        JSON.stringify(certificados_conformidade || []),
        garantia_anos || 5,
        req.user?.id || null,
      ]
    );
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[Quality] createCertificate error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── PUT /api/quality/:id ─────────────────────────────────────────────────────
export const updateCertificate = async (req, res) => {
  const {
    numero, certificado, paineis_balisticos, produtos, nota_fiscal,
    veiculo, data_emissao, material, norma, nivel,
    certificados_conformidade, garantia_anos,
  } = req.body;

  try {
    const { rows } = await query(
      `UPDATE maestro.quality_certificates SET
         numero=$1, certificado=$2, paineis_balisticos=$3, produtos=$4,
         nota_fiscal=$5, veiculo=$6, data_emissao=$7, material=$8, norma=$9,
         nivel=$10, certificados_conformidade=$11, garantia_anos=$12, updated_at=now()
       WHERE id=$13
       RETURNING *`,
      [
        numero, certificado, paineis_balisticos,
        JSON.stringify(produtos || []),
        nota_fiscal, veiculo, data_emissao || null,
        material || 'Dupont Kevlar® S745GR',
        norma || 'ABNT NBR 15000:2020-2',
        nivel || 'III-A',
        JSON.stringify(certificados_conformidade || []),
        garantia_anos || 5,
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Certificado não encontrado' });
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[Quality] updateCertificate error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── DELETE /api/quality/:id ──────────────────────────────────────────────────
export const deleteCertificate = async (req, res) => {
  try {
    const { rowCount } = await query(
      `DELETE FROM maestro.quality_certificates WHERE id = $1`,
      [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ success: false, message: 'Certificado não encontrado' });
    return res.json({ success: true });
  } catch (err) {
    console.error('[Quality] deleteCertificate error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET /api/quality/:id/pdf ─────────────────────────────────────────────────
export const generateCertificatePdf = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM maestro.quality_certificates WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Certificado não encontrado' });

    const pdfBytes = await buildCertificatePdf(rows[0]);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="certificado-qualidade-${rows[0].numero}.pdf"`);
    return res.end(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('[Quality] generateCertificatePdf error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── PDF builder ──────────────────────────────────────────────────────────────
async function buildCertificatePdf(cert) {
  const doc = await PDFDocument.create();

  const page = doc.addPage([841.89, 595.28]); // A4 landscape
  const { width, height } = page.getSize();

  const fontBold = await doc.embedFont(
    StandardFonts.HelveticaBold
  );

  const font = await doc.embedFont(
    StandardFonts.Helvetica
  );

  // ──────────────────────────────────────────────────────────────────────────
  // COLORS
  // ──────────────────────────────────────────────────────────────────────────

  const dark = rgb(0.08, 0.08, 0.08);
  const gray = rgb(0.45, 0.45, 0.45);
  const blue = rgb(0.06, 0.30, 0.58);
  const lightGray = rgb(0.88, 0.88, 0.88);

  // ──────────────────────────────────────────────────────────────────────────
  // PATHS
  // ──────────────────────────────────────────────────────────────────────────

  const backendRoot = path.join(__dirname, '..');

  const logoPath = path.join(
    backendRoot,
    'scripts',
    'projetos',
    'logo.png'
  );

  const kevlarLogoPath = path.join(
    backendRoot,
    'scripts',
    'projetos',
    'logo_kevlar.png'
  );

  const garantiaLogoPath = path.join(
    backendRoot,
    'scripts',
    'projetos',
    '5anos.png'
  );

  const assinaturaLogoPath = path.join(
    backendRoot,
    'scripts',
    'projetos',
    'assinatura_cordenador.png'
  );

  const footerCandidates = [
    path.join(
      backendRoot,
      'scripts',
      'projetos',
      'logo-footer.png'
    ),

    path.join(
      backendRoot,
      'scripts',
      'projetos',
      'footer.png'
    ),
  ];

  const footerPath = footerCandidates.find(c =>
    fs.existsSync(c)
  );

  // ──────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ──────────────────────────────────────────────────────────────────────────

  const embedImage = async filePath => {
    const bytes =
      await fs.promises.readFile(filePath);

    const ext = path
      .extname(filePath)
      .toLowerCase();

    if (
      ext === '.jpg' ||
      ext === '.jpeg'
    ) {
      return doc.embedJpg(bytes);
    }

    return doc.embedPng(bytes);
  };

  const truncateText = (
    text,
    maxWidth,
    fontRef,
    size
  ) => {
    if (
      fontRef.widthOfTextAtSize(
        text,
        size
      ) <= maxWidth
    ) {
      return text;
    }

    while (
      text.length > 0 &&
      fontRef.widthOfTextAtSize(
        `${text}...`,
        size
      ) > maxWidth
    ) {
      text = text.slice(0, -1);
    }

    return `${text}...`;
  };

  const wrapText = (
    text,
    maxW,
    fontRef,
    size
  ) => {
    const words = text.split(' ');

    const lines = [];

    let line = '';

    for (const word of words) {
      const test = line
        ? `${line} ${word}`
        : word;

      if (
        fontRef.widthOfTextAtSize(
          test,
          size
        ) > maxW &&
        line
      ) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }

    if (line) {
      lines.push(line);
    }

    return lines;
  };

  const drawWrapped = (
    text,
    fontRef,
    startY,
    size,
    maxWidth
  ) => {
    const lines = wrapText(
      text,
      maxWidth,
      fontRef,
      size
    );

    let y = startY;

    for (const line of lines) {
      page.drawText(line, {
        x: ml,
        y,
        size,
        font: fontRef,
        color: dark,
      });

      y -= size + 4;
    }

    return y;
  };

  // ──────────────────────────────────────────────────────────────────────────
  // LAYOUT
  // ──────────────────────────────────────────────────────────────────────────

  const ml = 52;

  const contentWidth = width - ml * 2;

  // ──────────────────────────────────────────────────────────────────────────
  // HEADER
  // ──────────────────────────────────────────────────────────────────────────

  const headerTop = height - 42;

  let operaLogoHeight = 0;

  let kevlarBottomY = headerTop;

  // OPERA

  if (fs.existsSync(logoPath)) {
    try {
      const logoImg =
        await embedImage(logoPath);

      const logoDim =
        logoImg.scale(1);

      const logoW = 120;

      const logoH =
        (logoDim.height /
          logoDim.width) *
        logoW;

      operaLogoHeight = logoH;

      page.drawImage(logoImg, {
        x: ml,
        y: headerTop - logoH,
        width: logoW,
        height: logoH,
      });

    } catch (err) {
      console.error(
        'Erro logo Opera:',
        err
      );
    }
  }

  // KEVLAR

  if (fs.existsSync(kevlarLogoPath)) {
    try {
      const kevlarImg =
        await embedImage(
          kevlarLogoPath
        );

      const kevlarDim =
        kevlarImg.scale(1);

      const kevlarW = 105;

      const kevlarH =
        (kevlarDim.height /
          kevlarDim.width) *
        kevlarW;

      kevlarBottomY =
        headerTop - kevlarH;

      page.drawImage(kevlarImg, {
        x: width - ml - kevlarW,
        y: kevlarBottomY,
        width: kevlarW,
        height: kevlarH,
      });

    } catch (err) {
      console.error(
        'Erro logo Kevlar:',
        err
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DIVIDER
  // ──────────────────────────────────────────────────────────────────────────

  const lineY =
    Math.min(
      headerTop - operaLogoHeight,
      kevlarBottomY
    ) - 18;

  page.drawLine({
    start: { x: ml, y: lineY },
    end: {
      x: width - ml,
      y: lineY,
    },
    thickness: 1.2,
    color: blue,
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TITLE
  // ──────────────────────────────────────────────────────────────────────────

  const title =
    `CERTIFICADO DE QUALIDADE Nº ${cert.numero || ''}`;

  const titleSize = 17;

  const titleW =
    fontBold.widthOfTextAtSize(
      title,
      titleSize
    );

  page.drawText(title, {
    x: (width - titleW) / 2,
    y: lineY - 32,
    size: titleSize,
    font: fontBold,
    color: dark,
  });

  // ──────────────────────────────────────────────────────────────────────────
  // FIELDS
  // ──────────────────────────────────────────────────────────────────────────

  const fieldY0 = lineY - 55;

  const labelSize = 10;

  const rowGap = 12;

  const col2X = width / 2 + 20;

  const produtos = Array.isArray(
    cert.produtos
  )
    ? cert.produtos
    : [];

  const produtoNomes = produtos
    .map(p => p.nome)
    .join('; ');

  const produtoQtds = produtos
    .map(p => p.quantidade_m2)
    .join('; ');

  const dataEmissao = cert.data_emissao
    ? new Date(
        cert.data_emissao
      ).toLocaleDateString(
        'pt-BR',
        {
          timeZone:
            'America/Sao_Paulo',
        }
      )
    : '';

  const leftFields = [
    [
      'Certificado:',
      cert.certificado || '',
    ],

    [
      'Painéis Balísticos:',
      cert.paineis_balisticos || '',
    ],

    [
      'Produto Ópera:',
      produtoNomes,
    ],

    [
      'Quantidade (m²):',
      produtoQtds,
    ],
  ];

  const rightFields = [
    [
      'Nota Fiscal:',
      cert.nota_fiscal || '',
    ],

    [
      'Veículo:',
      cert.veiculo || '',
    ],

    [
      'Data de Emissão:',
      dataEmissao,
    ],
  ];

  let lfY = fieldY0;

  for (const [label, value] of leftFields) {
    const lw =
      fontBold.widthOfTextAtSize(
        label,
        labelSize
      );

    page.drawText(label, {
      x: ml,
      y: lfY,
      size: labelSize,
      font: fontBold,
      color: dark,
    });

    page.drawText(
      truncateText(
        String(value),
        240,
        font,
        labelSize
      ),
      {
        x: ml + lw + 6,
        y: lfY,
        size: labelSize,
        font,
        color: dark,
      }
    );

    lfY -= rowGap;
  }

  let rfY = fieldY0;

  for (const [label, value] of rightFields) {
    const lw =
      fontBold.widthOfTextAtSize(
        label,
        labelSize
      );

    page.drawText(label, {
      x: col2X,
      y: rfY,
      size: labelSize,
      font: fontBold,
      color: dark,
    });

    page.drawText(
      truncateText(
        String(value),
        220,
        font,
        labelSize
      ),
      {
        x: col2X + lw + 6,
        y: rfY,
        size: labelSize,
        font,
        color: dark,
      }
    );

    rfY -= rowGap;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CONTENT DIVIDER
  // ──────────────────────────────────────────────────────────────────────────

  let fy =
    Math.min(lfY, rfY) - 10;

  page.drawLine({
    start: { x: ml, y: fy },
    end: {
      x: width - ml,
      y: fy,
    },
    thickness: 0.5,
    color: lightGray,
  });

  fy -= 22;

  // ──────────────────────────────────────────────────────────────────────────
  // BODY
  // ──────────────────────────────────────────────────────────────────────────

  const material =
    cert.material ||
    'Dupont Kevlar® S745GR';

  const nivel =
    cert.nivel || 'III-A';

  const norma =
    cert.norma ||
    'ABNT NBR 15000:2020-2';

  const bodySize = 9.5;

  const para1 =
    `A Ópera Armouring Materials certifica que o produto acima especificado foi produzido com o tecido de para-aramida ${material} e encontra-se em conformidade com o nível ${nivel} da norma ${norma}.`;

  fy = drawWrapped(
    para1,
    font,
    fy,
    bodySize,
    contentWidth
  );

  const certs = Array.isArray(
    cert.certificados_conformidade
  )
    ? cert.certificados_conformidade
    : [];

  if (certs.length > 0) {
    fy -= 6;

    const para2 =
      `A conformidade foi comprovada por meio de ensaios realizados pelo CPRM, conforme certificados de conformidade ${certs.join(' e ')}`;

    fy = drawWrapped(
      para2,
      font,
      fy,
      bodySize,
      contentWidth
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // RESERVA DE ESPAÇO
  // ──────────────────────────────────────────────────────────────────────────

  const garantiaArea = 120;
  const assinaturaArea = 80;
  const footerArea = 90;

  const minFy =
    garantiaArea +
    assinaturaArea +
    footerArea;

  if (fy < minFy) {
    fy = minFy;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GARANTIA IMAGE
  // ──────────────────────────────────────────────────────────────────────────

  fy -= 20;

  if (
    fs.existsSync(garantiaLogoPath)
  ) {
    try {
      const garantiaImg =
        await embedImage(
          garantiaLogoPath
        );

      const garantiaDim =
        garantiaImg.scale(1);

      const gW = 250;

      const gH =
        (garantiaDim.height /
          garantiaDim.width) *
        gW;

      const garantiaY = Math.max(
        fy - gH,
        150
      );

      page.drawImage(
        garantiaImg,
        {
          x: (width - gW) / 2,
          y: garantiaY,
          width: gW,
          height: gH,
        }
      );

      fy = garantiaY - 12;

    } catch (err) {
      console.error(
        'Erro garantia:',
        err
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ASSINATURA IMAGE
  // ──────────────────────────────────────────────────────────────────────────

  if (
    fs.existsSync(
      assinaturaLogoPath
    )
  ) {
    try {
      const assinaturaImg =
        await embedImage(
          assinaturaLogoPath
        );

      const assinaturaDim =
        assinaturaImg.scale(1);

      const sigW = 220;

      const sigH =
        (assinaturaDim.height /
          assinaturaDim.width) *
        sigW;

      const assinaturaY =
        fy - sigH + 30;

      page.drawImage(
        assinaturaImg,
        {
          x: (width - sigW) / 2,
          y: assinaturaY,
          width: sigW,
          height: sigH,
        }
      );

      fy = assinaturaY - 5;

    } catch (err) {
      console.error(
        'Erro assinatura:',
        err
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SIGNATURE LINE
  // ──────────────────────────────────────────────────────────────────────────

  const sigLineY = fy;

  page.drawLine({
    start: {
      x: width / 2 - 80,
      y: sigLineY,
    },

    end: {
      x: width / 2 + 80,
      y: sigLineY,
    },

    thickness: 1,
    color: dark,
  });

  const sigText =
    'Coordenador de Qualidade';

  page.drawText(sigText, {
    x:
      width / 2 -
      font.widthOfTextAtSize(
        sigText,
        9
      ) /
        2,

    y: sigLineY - 14,

    size: 9,

    font,

    color: dark,
  });

  // ──────────────────────────────────────────────────────────────────────────
  // FOOTER IMAGE
  // ──────────────────────────────────────────────────────────────────────────

  if (footerPath) {
    try {
      const footerImg =
        await embedImage(
          footerPath
        );

      const footerDim =
        footerImg.scale(1);

      const footerW = 620;

      const footerH =
        (footerDim.height /
          footerDim.width) *
        footerW;

      page.drawImage(
        footerImg,
        {
          x:
            (width - footerW) /
            2,

          y: 0,

          width: footerW,

          height: footerH,
        }
      );

    } catch (err) {
      console.error(
        'Erro footer:',
        err
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // FOOTER TEXT
  // ──────────────────────────────────────────────────────────────────────────

  const footerLineY = 38;

  page.drawLine({
    start: {
      x: ml,
      y: footerLineY,
    },

    end: {
      x: width - ml,
      y: footerLineY,
    },

    thickness: 0.5,

    color: lightGray,
  });

  const footerLines = [
    'Ópera Armouring Materials',

    'Avenida Tucunaré 421 - Tamboré - Barueri - SP - 06460-020',

    'www.opera.security',
  ];

  let footerY =
    footerLineY - 10;

  for (const line of footerLines) {
    const lw =
      font.widthOfTextAtSize(
        line,
        7
      );

    page.drawText(line, {
      x: (width - lw) / 2,

      y: footerY,

      size: 7,

      font,

      color: gray,
    });

    footerY -= 10;
  }

  return doc.save();
}
