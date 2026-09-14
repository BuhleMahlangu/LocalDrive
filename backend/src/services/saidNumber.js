// South African identity number validation. An SA ID is 13 digits: YYMMDDSSSSCAZ
// where YYMMDD is the birthdate, SSSS the gender/sequence digits, CSA the
// citizenship/status digits and Z a Luhn-mod-10 checksum over the first 12.
function isValidSaId(value) {
  const id = String(value || '').trim();
  if (!/^\d{13}$/.test(id)) return false;

  const y = Number(id.slice(0, 2));
  const m = Number(id.slice(2, 4));
  const d = Number(id.slice(4, 6));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;

  // Birth year is 0-99 with the century inferred from the current date.
  const year = y <= new Date().getFullYear() % 100 ? 2000 + y : 1900 + y;
  const date = new Date(Date.UTC(year, m - 1, d));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;

  // Luhn over the first 12 digits: double every second digit counting from the
  // right (positions 2,4,6,8,10,12 → 0-indexed odd positions).
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    let n = Number(id[i]) * (i % 2 === 1 ? 2 : 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(id[12]);
}

module.exports = { isValidSaId };