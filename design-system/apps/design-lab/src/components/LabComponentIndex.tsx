import { useEffect, useRef, useState } from "react";
import { Button, Icon as CatalogIcon, OverflowText, SearchField } from "@openbitfun/ui";
import { componentRegistry } from "@openbitfun/ui/registry";
import { useI18n } from "../i18n";
import { getComponentCategoryLabel, getComponentDescription } from "../i18n/componentMetadata";

/* The component directory belongs to the navigation, not to a second index beside it: it hangs
   under the Components route in the rail, the way the Foundations chapters hang under theirs. It
   keeps its own search and its own scroll region, so a list this long never pushes the other
   routes out of the rail. */
export function LabComponentIndex({ selected }: { selected?: string }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLElement>(null);
  const activeLinkRef = useRef<HTMLAnchorElement>(null);
  const categories = Array.from(new Set(componentRegistry.map(component => component.category)));
  const normalizedQuery = query.trim().toLowerCase();
  const catalogComponents = componentRegistry.filter(component =>
    `${component.name} ${component.category} ${component.description} ${getComponentDescription(component.name, component.description, t)} ${getComponentCategoryLabel(component.category, t)}`.toLowerCase().includes(normalizedQuery),
  );

  useEffect(() => {
    const list = listRef.current;
    const activeLink = activeLinkRef.current;
    if (!list) return;
    if (!activeLink) {
      list.scrollTop = 0;
      return;
    }
    // Keep the open component visible inside the directory without moving the page itself.
    const listBounds = list.getBoundingClientRect();
    const linkBounds = activeLink.getBoundingClientRect();
    if (linkBounds.top < listBounds.top) list.scrollTop += linkBounds.top - listBounds.top;
    else if (linkBounds.bottom > listBounds.bottom) list.scrollTop += linkBounds.bottom - listBounds.bottom;
  }, [selected, normalizedQuery]);

  return (
    <div className="design-navigation-index">
      <SearchField aria-label={t("design.search")} placeholder={t("design.search")} value={query}
        onChange={event => setQuery(event.target.value)} clearLabel={t("design.clear")} onClear={() => setQuery("")}
        leadingIcon={<CatalogIcon name="search" />} />
      {/* The directory can be counted by looking, so the rail does not print the total — but a reader
          who cannot see the list still needs the filtered count as the query changes. The region stays
          live and comes off screen instead of out of the page. */}
      <span className="design-sr-only" role="status">{t("design.results", { count: catalogComponents.length })}</span>
      <nav className="design-library-list" aria-label={t("design.all")} ref={listRef}>
        {categories.map(group => {
          const items = catalogComponents.filter(item => item.category === group).sort((a, b) => a.name.localeCompare(b.name));
          if (!items.length) return null;
          return (
            <section className="design-library-group" key={group} aria-labelledby={`component-group-${group}`}>
              <h3 id={`component-group-${group}`}>{getComponentCategoryLabel(group, t)}</h3>
              <ul>
                {items.map(item => (
                  <li key={item.name}>
                    <a data-overflow-trigger className="design-library-link" href={`#component/${item.name.toLowerCase()}`}
                      aria-current={selected === item.name ? "page" : undefined}
                      ref={selected === item.name ? activeLinkRef : undefined}
                      title={`${item.name} · ${getComponentDescription(item.name, item.description, t)}`}>
                      <OverflowText>{item.name}</OverflowText>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {catalogComponents.length === 0 && (
          <div className="design-library-empty">
            <p>{t("design.noResults")}</p>
            <Button size="sm" variant="text" onClick={() => setQuery("")}>{t("design.clear")}</Button>
          </div>
        )}
      </nav>
    </div>
  );
}
