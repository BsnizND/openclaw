export type CodexUserInput =
  | {
      type: "text";
      text: string;
      text_elements: Array<{
        byteRange: { start: number; end: number };
        placeholder: string | null;
      }>;
    }
  | {
      type: "image";
      url: string;
    }
  | {
      type: "localImage";
      path: string;
    }
  | {
      type: "skill";
      name: string;
      path: string;
    };
