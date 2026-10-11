/** PDF dates (ISO 32000-1 §7.9.4): `D:YYYYMMDDHHmmSSOHH'mm'`, fields after the year optional. */

const PDF_DATE =
  /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([+\-Z])(?:(\d{2})'?(?:(\d{2})'?)?)?)?/u;

/** PDF date -> ISO 8601; undefined when malformed. Zone-less dates count as UTC. */
export function fromPdfDate(value: string | undefined): string | undefined {
  const m = PDF_DATE.exec(value?.trim() ?? "");
  if (!m) {
    return undefined;
  }
  const [, year, month = "01", day = "01", hour = "00", minute = "00", second = "00", sign, oh = "00", om = "00"] = m;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const offset = sign === "+" || sign === "-" ? (Number(oh) * 60 + Number(om)) * (sign === "-" ? -1 : 1) : 0;
  return new Date(utc - offset * 60_000).toISOString();
}

/** Date -> PDF date in local time with its UTC offset, like Acrobat. */
export function toPdfDate(date: Date): string {
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset > 0 ? "+" : offset < 0 ? "-" : "Z";
  const zone = sign === "Z" ? "Z" : `${sign}${pad(offset / 60)}'${pad(offset % 60)}'`;
  return (
    `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${zone}`
  );
}
