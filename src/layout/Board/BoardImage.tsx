//! An image pasted into a card description, drawn in the description preview. The file lives on the backend host,
//! which the WebView cannot read directly, so it is fetched by file name from the app's board-images folder.
import { useEffect, useState } from "react";
import type { Tokens } from "marked";
import { boardImageName, boardImageRead } from "../../ipc/board";
import { mimeFromPath } from "../CenterPane/doc/docImageIO";

function BoardImage({ name, alt }: { name: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    boardImageRead(name).then(
      (data) => live && setSrc(`data:${mimeFromPath(name)};base64,${data}`),
      () => live && setSrc(null),
    );
    return () => {
      live = false;
    };
  }, [name]);
  return src ? <img className="board-desc-img" src={src} alt={alt} /> : <span className="sv-img">{alt || name}</span>;
}

/** `MarkdownImageRenderer` for card descriptions: draws pasted board images, leaves anything else as text. */
export function renderBoardImage(image: Tokens.Image) {
  const name = boardImageName(image.href);
  return name ? <BoardImage name={name} alt={image.text} /> : null;
}
