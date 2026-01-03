import { Streamdown } from "streamdown";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({
  content,
  className = "",
}: MarkdownRendererProps) {
  return (
    <div className={`markdown-content ${className}`}>
      <Streamdown mode="static">{content}</Streamdown>
    </div>
  );
}
