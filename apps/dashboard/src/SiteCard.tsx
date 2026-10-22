import { useEffect, useState, type FormEvent } from "react";
import type { Api, Site } from "./api";
import { errorMessage } from "./format";

// The site's address (#81): the diary reads the weather of each day for it.
export const SiteCard = ({ api, projectId }: { api: Api; projectId: string }) => {
  const [site, setSite] = useState<Site | null>(null);
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getSite(projectId)
      .then((loaded) => {
        setSite(loaded);
        setAddress(loaded?.address ?? "");
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [api, projectId]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await api.putSite(projectId, address.trim());
      setSite(saved);
      setMessage(
        saved.lat === null
          ? "Zapisano adres, ale nie znalazłem tej miejscowości. Wpisz na końcu nazwę miejscowości, np. „ul. Polna 3, Piława Górna”."
          : `Pogoda będzie czytana dla: ${saved.found ?? `${saved.lat.toFixed(3)}, ${saved.lon?.toFixed(3)}`}.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card create-form" onSubmit={(event) => void save(event)}>
      <label className="field grow">
        <span>Lokalizacja budowy</span>
        <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="np. ul. Polna 3, 58-240 Piława Górna" />
        {message ? <span className="muted small">{message}</span> : null}
        {!message && site?.lat != null ? <span className="muted small">Pogoda w dzienniku jest czytana dla tego miejsca.</span> : null}
        {error ? <span className="error small">{error}</span> : null}
      </label>
      <button type="submit" className="button" disabled={saving || address.trim() === (site?.address ?? "")}>
        {saving ? "Zapisuję…" : "Zapisz"}
      </button>
    </form>
  );
};
