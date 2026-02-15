import { useCallback, useEffect } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

interface FileViewerProps {
  content: string;
  editable?: boolean;
  onChange?: (markdown: string) => void;
}

export function FileViewer({
  content,
  editable = false,
  onChange,
}: FileViewerProps) {
  const editor = useCreateBlockNote();

  useEffect(() => {
    async function load() {
      const blocks = await editor.tryParseMarkdownToBlocks(
        content,
      );
      editor.replaceBlocks(editor.document, blocks);
    }
    void load();
  }, [editor, content]);

  const handleChange = useCallback(() => {
    if (!onChange) return;
    async function convert() {
      const md = await editor.blocksToMarkdownLossy(
        editor.document,
      );
      onChange!(md);
    }
    void convert();
  }, [editor, onChange]);

  return (
    <div
      style={{
        fontFamily: "var(--sv-font-sans)",
        color: "var(--sv-foreground)",
        backgroundColor: "var(--sv-background)",
      }}
    >
      <BlockNoteView
        editor={editor}
        editable={editable}
        onChange={handleChange}
      />
    </div>
  );
}
