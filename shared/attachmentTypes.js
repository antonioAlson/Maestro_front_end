// Single source of truth for cutting-plan attachment types.
// Consumed by:
//   - filesController.js (server-side validation)
//   - GET /api/files/attachment-types  (frontend bootstraps from this)
//
// To add a new attachment type: add an entry to ATTACHMENT_TYPES and reference
// it in MATERIAL_ATTACHMENTS. No other file should hard-code these strings.

export const LABEL_CONTENT_PATTERN = 'X{5}'; // regex source, exported as string for portability
export const LABEL_CONTENT_REGEX   = /X{5}/;

// Per-type definition.
// validateLabelPattern: when true, file content must match LABEL_CONTENT_REGEX.
export const ATTACHMENT_TYPES = {
  infoproject:    { label: 'Docs do Projeto',    accept: '.pdf',     mime: ['application/pdf'], required: true,  validateLabelPattern: false },
  label_8c:       { label: 'Etiqueta 8C',        accept: '.txt,.TXT', mime: ['text/plain'],     required: false, validateLabelPattern: true  },
  label_9c:       { label: 'Etiqueta 9C',        accept: '.txt,.TXT', mime: ['text/plain'],     required: false, validateLabelPattern: true  },
  label_11c:      { label: 'Etiqueta 11C',       accept: '.txt,.TXT', mime: ['text/plain'],     required: false, validateLabelPattern: true  },
  label_tensylon: { label: 'Etiqueta Tensylon',  accept: '.txt,.TXT', mime: ['text/plain'],     required: false, validateLabelPattern: true  },
};

// Allowed attachment types per material.
export const MATERIAL_ATTACHMENTS = {
  ARAMIDA:  ['infoproject', 'label_8c', 'label_9c', 'label_11c'],
  TENSYLON: ['infoproject', 'label_tensylon'],
};

// Helpers built from the above (so callers never re-derive these).
export const ALLOWED_TYPES         = Object.keys(ATTACHMENT_TYPES);
export const MIME_BY_TYPE          = Object.fromEntries(ALLOWED_TYPES.map((t) => [t, ATTACHMENT_TYPES[t].mime]));
export const PATTERN_VALIDATED     = ALLOWED_TYPES.filter((t) => ATTACHMENT_TYPES[t].validateLabelPattern);

export function isTypeAllowedForMaterial(materialType, attachmentType) {
  const mt = (materialType || '').toUpperCase();
  return (MATERIAL_ATTACHMENTS[mt] || []).includes(attachmentType);
}

// Payload returned to the frontend by GET /api/files/attachment-types.
// Frontend renders attachment fields straight from this — no client-side duplication.
export function buildPublicConfig() {
  const defsByMaterial = {};
  for (const [material, types] of Object.entries(MATERIAL_ATTACHMENTS)) {
    defsByMaterial[material] = types.map((type) => ({
      type,
      label:    ATTACHMENT_TYPES[type].label,
      accept:   ATTACHMENT_TYPES[type].accept,
      required: ATTACHMENT_TYPES[type].required,
      validateLabelPattern: ATTACHMENT_TYPES[type].validateLabelPattern,
    }));
  }
  return {
    labelPattern: LABEL_CONTENT_PATTERN,
    byMaterial:   defsByMaterial,
  };
}
