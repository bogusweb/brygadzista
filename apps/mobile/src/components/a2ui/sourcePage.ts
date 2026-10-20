import { createContext, useContext } from "react";
import type { ReactNode } from "react";

// Opens a cited page; the chat fills in the document when the source names only the page.
type OpenSourcePage = (pageNo: number, documentId?: string) => void;
const OpenSourcePageContext = createContext<OpenSourcePage>(() => {});
export const A2UIPageProvider = OpenSourcePageContext.Provider;
export const useOpenSourcePage = () => useContext(OpenSourcePageContext);

export type ComponentRenderer = (props: Record<string, unknown>, children: ReactNode[]) => ReactNode;
