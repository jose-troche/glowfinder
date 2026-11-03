type Child = Node | string | null | undefined | false;

/** Tiny element builder: el("td", { class: "num" }, ["3.72"]). Text is never parsed as HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

export function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
}
