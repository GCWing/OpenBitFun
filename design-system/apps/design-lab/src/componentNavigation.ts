import { componentRegistry, type ComponentMeta } from "@openbitfun/ui/registry";

/* Which directory route belongs to which component category. The shell passes it to the page and
   the rail reads it back, so both agree on the route without duplicating the mapping. */
export function libraryCategory(page: string): ComponentMeta["category"] | undefined {
  return page === "mobile" ? "mobile" : page === "flow-chat" ? "flow-chat" : undefined;
}

/* The component a directory route opens with. Shared so the rail can mark the same row the page is
   showing when the route names no component of its own. */
export function defaultComponent(category?: ComponentMeta["category"]): ComponentMeta | undefined {
  return componentRegistry.find(item => category ? item.category === category : item.name === "Button")
    ?? componentRegistry[0];
}
