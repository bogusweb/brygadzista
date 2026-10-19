import { useEffect, useState } from "react";

const IMAGE_RETRY_MS = 5000;

// Pages are rendered by the indexer one by one, so a missing image is retried until it shows up.
export const PageImage = ({ src, alt, className }: { src: string; alt: string; className: string }) => {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setAttempt(0);
    setFailed(false);
  }, [src]);
  useEffect(() => {
    if (!failed) return;
    const timer = window.setTimeout(() => {
      setFailed(false);
      setAttempt((value) => value + 1);
    }, IMAGE_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [failed]);
  if (failed) return <div className={`${className} placeholder muted small`}>Strona jeszcze się renderuje</div>;
  const url = attempt > 0 ? `${src}&retry=${attempt}` : src;
  return <img className={className} src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
};
