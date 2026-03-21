/** Renders translated strings that contain <em> HTML tags */
export function RichText({ html, className }: { html: string; className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
