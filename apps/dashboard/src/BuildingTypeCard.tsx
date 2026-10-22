import { useEffect, useState } from "react";
import type { Api, BuildingType } from "./api";
import { errorMessage } from "./format";

// Kinds of building (#85), loaded once per screen; the server is the one list of them.
export const useBuildingTypes = (api: Api) => {
  const [types, setTypes] = useState<BuildingType[]>([]);
  useEffect(() => {
    api
      .listBuildingTypes()
      .then(setTypes)
      .catch(() => setTypes([]));
  }, [api]);
  return types;
};

export const BuildingTypeSelect = ({
  types,
  value,
  onChange,
  disabled = false,
}: {
  types: BuildingType[];
  value: string;
  onChange: (type: string) => void;
  disabled?: boolean;
}) => (
  <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled || types.length === 0}>
    {types.map((type) => (
      <option key={type.type} value={type.type}>
        {type.label}
      </option>
    ))}
  </select>
);

// Changing the type keeps checklists already made; it only changes which stages the app offers first.
export const BuildingTypeCard = ({ api, projectId }: { api: Api; projectId: string }) => {
  const types = useBuildingTypes(api);
  const [saved, setSaved] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listProjects()
      .then((projects) => {
        const type = projects.find((project) => project.id === projectId)?.buildingType ?? null;
        setSaved(type);
        setValue(type ?? "");
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [api, projectId]);

  const save = async (type: string) => {
    setValue(type);
    setSaving(true);
    setError(null);
    try {
      const project = await api.updateProject(projectId, { buildingType: type });
      setSaved(project.buildingType);
    } catch (cause) {
      setValue(saved ?? "");
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const stages = types.find((type) => type.type === value)?.stages.length;
  return (
    <div className="card create-form">
      <label className="field grow">
        <span>Typ budowy</span>
        <BuildingTypeSelect types={types} value={value} onChange={(type) => void save(type)} disabled={saving || saved === null} />
        <span className="muted small">
          {stages ? `Aplikacja proponuje najpierw ${stages} etapów odbioru dla tego typu. ` : ""}
          Zmiana nie usuwa zrobionych checklist.
        </span>
        {error ? <span className="error small">{error}</span> : null}
      </label>
    </div>
  );
};
