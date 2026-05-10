type ToolCallEvent = {
  toolName: string;
  input: unknown;
};

type ExtensionAPI = {
  on(event: "tool_call", handler: (event: ToolCallEvent) => void | Promise<void>): void;
};

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash" || !isBashInput(event.input)) return;

    event.input.command = `shopt -s expand_aliases\nalias rg='rgk'\n${event.input.command}`;
  });
}

function isBashInput(input: unknown): input is { command: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "command" in input &&
    typeof input.command === "string"
  );
}
