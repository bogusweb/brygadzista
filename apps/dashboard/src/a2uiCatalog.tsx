import { createCatalog, type CatalogRenderers } from "@copilotkit/a2ui-renderer";
import {
  A2UI_CATALOG_ID,
  a2uiCatalogDefinitions,
  a2uiItemSchemas,
  type A2UISource,
} from "@brygadzista/server/a2ui-catalog";
import { createContext, useContext, type ReactNode } from "react";
import { usePageViewer } from "./pageViewer";

// Renderers for the construction components of the A2UI catalog. The definitions (props and the
// descriptions the model reads) live on the server, apps/server/src/a2ui-catalog.ts.

// A source without a documentId points at the project's first indexed PDF.
const FallbackDocumentContext = createContext<string | null>(null);
export const A2UIDocumentProvider = FallbackDocumentContext.Provider;

// Bound values are resolved before rendering, but the model can still send the wrong type.
const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");

type ItemSchema<T> = { safeParse: (value: unknown) => { success: true; data: T } | { success: false } };

const listItems = <T,>(value: unknown, item: ItemSchema<T>): T[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const parsed = item.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    : [];

const SourceLink = ({ source }: { source: A2UISource | undefined }) => {
  const viewer = usePageViewer();
  const fallback = useContext(FallbackDocumentContext);
  if (!source) return null;
  const documentId = source.documentId ?? fallback;
  const label = `str. ${source.page}`;
  if (!documentId) return <span className="a2ui-source small">{label}</span>;
  return (
    <button type="button" className="link source-link a2ui-source small" onClick={() => viewer.open(documentId, source.page)}>
      {label}
    </button>
  );
};

const Block = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="a2ui-block">
    {title && <h3 className="a2ui-title">{title}</h3>}
    {children}
  </section>
);

const Empty = () => <p className="muted small">Brak pozycji.</p>;

const renderers: CatalogRenderers<typeof a2uiCatalogDefinitions> = {
  ParameterCard: ({ props }) => (
    <div className="a2ui-block a2ui-parameter">
      <span className="a2ui-label small">{text(props.label)}</span>
      <span className="a2ui-value tabular">
        {text(props.value)}
        {text(props.unit) && <span className="a2ui-unit"> {text(props.unit)}</span>}
      </span>
      {(text(props.note) || props.source) && (
        <span className="a2ui-meta small">
          {text(props.note)}
          {text(props.note) && props.source && " · "}
          <SourceLink source={props.source} />
        </span>
      )}
    </div>
  ),

  MaterialList: ({ props }) => {
    const items = listItems(props.items, a2uiItemSchemas.material);
    return (
      <Block title={text(props.title)}>
        {items.length === 0 ? (
          <Empty />
        ) : (
          <ul className="a2ui-rows">
            {items.map((item, index) => (
              <li key={index} className="a2ui-row">
                <span className="a2ui-row-main">
                  <span>{item.name}</span>
                  {(item.note || item.source) && (
                    <span className="a2ui-meta small">
                      {item.note}
                      {item.note && item.source && " · "}
                      <SourceLink source={item.source} />
                    </span>
                  )}
                </span>
                {item.quantity !== undefined && (
                  <span className="a2ui-quantity tabular">
                    {text(item.quantity)}
                    {item.unit && ` ${item.unit}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Block>
    );
  },

  WorkSteps: ({ props }) => {
    const steps = listItems(props.steps, a2uiItemSchemas.step);
    return (
      <Block title={text(props.title)}>
        {steps.length === 0 ? (
          <Empty />
        ) : (
          <ol className="a2ui-steps">
            {steps.map((step, index) => (
              <li key={index} className="a2ui-step">
                <span className="a2ui-step-no tabular" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="a2ui-row-main">
                  <strong>{step.title}</strong>
                  {step.detail && <span>{step.detail}</span>}
                  {step.source && (
                    <span className="a2ui-meta small">
                      <SourceLink source={step.source} />
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Block>
    );
  },

  LayerComparison: ({ props }) => {
    const partitions = listItems(props.partitions, a2uiItemSchemas.partition);
    const highlight = typeof props.highlight === "number" ? props.highlight : -1;
    return (
      <Block title={text(props.title)}>
        {partitions.length === 0 ? (
          <Empty />
        ) : (
          <div className="a2ui-partitions">
            {partitions.map((partition, index) => (
              <article key={index} className={`a2ui-partition${index === highlight ? " highlight" : ""}`}>
                <header className="a2ui-partition-head">
                  <strong>{partition.name}</strong>
                  <span className="a2ui-meta small">
                    {[partition.total && `razem ${partition.total}`, partition.uValue && `U = ${partition.uValue}`]
                      .filter(Boolean)
                      .join(" · ")}
                    {(partition.total || partition.uValue) && partition.source && " · "}
                    <SourceLink source={partition.source} />
                  </span>
                </header>
                <ol className="a2ui-layers" aria-label="Warstwy od zewnątrz do wewnątrz">
                  {partition.layers.map((layer, layerIndex) => (
                    <li key={layerIndex} className="a2ui-layer">
                      <span className="a2ui-row-main">
                        <span>{layer.material}</span>
                        {layer.note && <span className="a2ui-meta small">{layer.note}</span>}
                      </span>
                      {layer.thickness && <span className="a2ui-quantity tabular">{layer.thickness}</span>}
                    </li>
                  ))}
                </ol>
              </article>
            ))}
          </div>
        )}
      </Block>
    );
  },
};

export const a2uiCatalog = createCatalog(a2uiCatalogDefinitions, renderers, {
  catalogId: A2UI_CATALOG_ID,
  includeBasicCatalog: true,
});
