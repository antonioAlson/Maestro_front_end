// GS1 mod-10 check digit, calculado da direita para esquerda com pesos
// alternados 3 e 1 (último dígito de dados recebe peso 3). Funciona para
// qualquer comprimento de dados (EAN-13, IIS-23, GTIN-14, etc.).

export function computeGs1CheckDigit(data) {
  if (typeof data !== 'string' || !/^[0-9]+$/.test(data)) {
    throw new Error('computeGs1CheckDigit: data deve ser string só de dígitos');
  }
  const n = data.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const posFromRight = n - i;
    const weight = posFromRight % 2 === 1 ? 3 : 1;
    sum += Number(data[i]) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

export function validateGs1CheckDigit(codeWithDv) {
  if (typeof codeWithDv !== 'string' || codeWithDv.length < 2) return false;
  const data = codeWithDv.slice(0, -1);
  const dv = Number(codeWithDv.slice(-1));
  return computeGs1CheckDigit(data) === dv;
}
