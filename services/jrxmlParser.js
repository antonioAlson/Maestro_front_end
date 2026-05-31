// Parser leve de .jrxml (JasperReports) — extrai as "variáveis" que uma versão
// de relatório expõe, para a UI carregar nome + tipo de cada uma e para
// scaffolding do código JS que monta os parâmetros.
//
// Sem dependência de XML: o .jrxml é XML bem formado e os elementos que nos
// interessam (<parameter>, <field>, <variable>) carregam name/class como
// atributos simples. Usamos regex direcionada por elemento.

const IMAGE_CLASSES = new Set([
  'java.awt.image.BufferedImage',
  'java.awt.Image',
  'net.sf.jasperreports.engine.JRRenderable',
  'net.sf.jasperreports.renderers.Renderable',
]);

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

// Captura o conteúdo da primeira tag de abertura de um elemento (atributos),
// independente de ser self-closed (<x .../>) ou ter filhos (<x ...>...</x>).
function collectOpenTags(xml, element) {
  const re = new RegExp(`<${element}\\b([^>]*?)/?>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function shortType(className) {
  if (!className) return null;
  const parts = className.split('.');
  return parts[parts.length - 1];
}

export function parseJrxml(xml) {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new Error('jrxml vazio ou inválido');
  }

  const parameters = collectOpenTags(xml, 'parameter')
    .map((t) => {
      const className = attr(t, 'class');
      const cls = className || 'java.lang.String';
      return {
        name: attr(t, 'name'),
        class: cls,
        type: shortType(cls),
        isImage: IMAGE_CLASSES.has(cls),
      };
    })
    .filter((p) => p.name);

  const fields = collectOpenTags(xml, 'field')
    .map((t) => {
      const cls = attr(t, 'class') || 'java.lang.String';
      return { name: attr(t, 'name'), class: cls, type: shortType(cls) };
    })
    .filter((f) => f.name);

  const variables = collectOpenTags(xml, 'variable')
    .map((t) => {
      const cls = attr(t, 'class') || 'java.lang.String';
      return {
        name: attr(t, 'name'),
        class: cls,
        type: shortType(cls),
        calculation: attr(t, 'calculation') || 'Nothing',
      };
    })
    .filter((v) => v.name);

  // queryString (SQL interno do relatório), normalmente em CDATA.
  let queryString = null;
  const qsMatch = xml.match(/<queryString[^>]*>([\s\S]*?)<\/queryString>/i);
  if (qsMatch) {
    const inner = qsMatch[1];
    const cdata = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    queryString = (cdata ? cdata[1] : inner).trim() || null;
  }

  // Nome do relatório declarado no .jrxml (atributo name do <jasperReport>).
  const reportName = attr((xml.match(/<jasperReport\b([^>]*)>/) || [, ''])[1] || '', 'name');

  return { reportName, parameters, fields, variables, queryString };
}

export default { parseJrxml };
