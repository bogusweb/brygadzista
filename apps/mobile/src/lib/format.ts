// Polish has three plural forms: 1 strona, 2–4 strony (but 12–14 stron), 5+ stron.
export const pluralPl = (count: number, one: string, few: string, many: string) => {
  if (count === 1) return `${count} ${one}`;
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  const isFew = lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14);
  return `${count} ${isFew ? few : many}`;
};

export const formatMegabytes = (bytes: number) => {
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes < 10 ? megabytes.toFixed(1).replace(".", ",") : Math.round(megabytes)} MB`;
};
