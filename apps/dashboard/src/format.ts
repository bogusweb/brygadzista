export const dateFormat = new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium" });

// Polish plurals: 1 dokument, 2–4 dokumenty (except 12–14), 5+ dokumentów.
export const pluralize = (count: number, one: string, few: string, many: string) => {
  if (count === 1) return `1 ${one}`;
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  const isFew = lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14);
  return `${count} ${isFew ? few : many}`;
};

export const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.ceil(bytes / 1024)} kB`;

export const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Coś poszło nie tak. Spróbuj ponownie.";
