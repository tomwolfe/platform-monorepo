"use client";

import React from "react";
import { ToolResultRenderer } from "./ToolResultRenderer";
import { isToolUIPart, getToolName } from "ai";
import { Loader2 } from "lucide-react";

interface MessageBubbleProps {
  message: any;
  isLast?: boolean;
  isStreaming?: boolean;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  isLast = false,
  isStreaming = false,
}) => {
  const isUser = message.role === "user";

  return (
    <div
      className={`flex flex-col ${isUser ? "items-end" : "items-start"} ${isLast ? "mb-6" : "mb-4"}`}
    >
      <div
        className={`max-w-[85%] rounded-2xl px-5 py-3.5 shadow-sm transition-all ${
          isUser
            ? "bg-black text-white rounded-br-md"
            : "bg-white border border-slate-200 text-slate-900 rounded-bl-md"
        }`}
      >
        {message.parts.map((part: any, partIndex: number) => {
          if (part.type === "text") {
            return (
              <p
                key={partIndex}
                className="text-[15px] leading-relaxed whitespace-pre-wrap font-normal"
              >
                {part.text}
              </p>
            );
          }

          if (isToolUIPart(part)) {
            const toolInvocation = part;
            const toolName = getToolName(toolInvocation);

            return (
              <div key={partIndex} className="mt-3">
                <ToolResultRenderer
                  toolName={toolName}
                  toolInvocation={toolInvocation}
                />
              </div>
            );
          }

          return null;
        })}

        {isStreaming && isLast && !isUser && (
          <div className="flex items-center gap-1.5 mt-2 text-slate-400">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
