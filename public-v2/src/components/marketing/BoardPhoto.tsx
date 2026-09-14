/**
 * A board's background: one photograph, still.
 *
 * The site has one film — the hero. Every other photographic board is a
 * still, and each photograph is used exactly once across the product
 * (docs/design/SHOT_LIST.md). Motion behind every section read as wallpaper:
 * it competed with the type, and five short clips repeated page after page.
 *
 * The scrim lives here so type over any photograph has a floor it can rely
 * on.
 */
import { publicAsset } from '../../lib/publicAsset';

export function BoardPhoto({ still, position }: { still: string; position?: string }) {
  return (
    <div className="mk-board-film" aria-hidden="true">
      <img src={publicAsset(still)} alt="" loading="lazy" decoding="async" style={position ? { objectPosition: position } : undefined} />
      <span className="mk-board-scrim" />
    </div>
  );
}
