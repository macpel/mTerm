//! An image pasted into a card description, drawn in the description preview. The file lives on the backend host,
//! which the WebView cannot read directly, so it is loaded the same way document images are.
import { useEffect, useState } from "react";
import type { Tokens } from "marked";
import { isBoardImage } from "../../ipc/board";
import { proxyDocImageURL } from "../CenterPane/doc/docImageIO";

function BoardImage({ href, alt }: { href: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void proxyDocImageURL(href, "").then((url) => {
      if (live && url !== href) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [href]);
  return src ? <img className="board-desc-img" src={src} alt={alt} /> : <span className="sv-img">{alt || href}</span>;
}

/** `MarkdownImageRenderer` for card descriptions: draws pasted board images, leaves anything else as text. */
export function renderBoardImage(image: Tokens.Image) {
  return isBoardImage(image.href) ? <BoardImage href={image.href} alt={image.text} /> : null;
}
