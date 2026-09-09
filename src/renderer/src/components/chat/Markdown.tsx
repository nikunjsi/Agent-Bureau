import { parseMarkdown, type Block, type Inline } from './markdownParser';

/** Renders the parsed subset as real React elements. No HTML string is
 * built anywhere in this path, so there is nothing to sanitise — see
 * markdownParser.ts for why that is the design rather than a shortcut. */
function InlineRun({ content }: { content: Inline[] }): React.JSX.Element {
  return (
    <>
      {content.map((node, index) => {
        switch (node.kind) {
          case 'strong':
            return (
              <strong key={index} className="font-semibold">
                {node.text}
              </strong>
            );
          case 'em':
            return (
              <em key={index} className="italic">
                {node.text}
              </em>
            );
          case 'code':
            return (
              <code
                key={index}
                className="rounded bg-bureau-bg-elevated px-1 py-0.5 font-mono text-[0.9em]"
              >
                {node.text}
              </code>
            );
          case 'link':
            return (
              <a
                key={index}
                href={node.href}
                onClick={(event) => {
                  // Never navigate the renderer itself: the window is the
                  // app, and a link that replaced it would take the user's
                  // only way back (standing rule 5's neighbourhood).
                  event.preventDefault();
                  void window.bureau.system.openExternal({ url: node.href });
                }}
                className="text-bureau-accent underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
              >
                {node.text}
              </a>
            );
          default:
            return <span key={index}>{node.text}</span>;
        }
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }): React.JSX.Element {
  switch (block.kind) {
    case 'heading': {
      const className = 'mt-2 font-semibold first:mt-0';
      if (block.level === 1)
        return (
          <h3 className={`${className} text-base`}>
            <InlineRun content={block.content} />
          </h3>
        );
      if (block.level === 2)
        return (
          <h4 className={`${className} text-sm`}>
            <InlineRun content={block.content} />
          </h4>
        );
      return (
        <h5 className={`${className} text-sm`}>
          <InlineRun content={block.content} />
        </h5>
      );
    }
    case 'code':
      return (
        <pre className="my-1 overflow-x-auto rounded bg-bureau-bg-elevated p-2 text-xs">
          <code>{block.text}</code>
        </pre>
      );
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index} className="ml-4 list-outside">
          <InlineRun content={item} />
        </li>
      ));
      return block.ordered ? (
        <ol className="my-1 list-decimal">{items}</ol>
      ) : (
        <ul className="my-1 list-disc">{items}</ul>
      );
    }
    default:
      return (
        <p className="my-1 first:mt-0 last:mb-0 whitespace-pre-wrap">
          <InlineRun content={block.content} />
        </p>
      );
  }
}

export function Markdown({ source }: { source: string }): React.JSX.Element {
  const blocks = parseMarkdown(source);
  return (
    <div className="text-sm leading-relaxed">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  );
}
