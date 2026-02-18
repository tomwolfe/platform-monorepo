"use client";

import { useState, useEffect, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { Trash2, MapPin, Loader2, Mic, SendHorizontal } from "lucide-react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { ActionChips, ActionChip } from "@/components/chat/ActionChips";
import { Restaurant } from "@/components/chat/RestaurantCard";
import { useMesh } from "@/hooks/useMesh";

const ROTATING_PLACEHOLDERS = [
  "Book a table for dinner...",
  "Find a ride to the airport...",
  "Check the weather this weekend...",
  "Schedule a meeting...",
  "Plan a dinner and add to calendar...",
];

export default function Home() {
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [input, setInput] = useState("");
  const [selectedRestaurant, setSelectedRestaurant] = useState<Restaurant | null>(null);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { messages, setMessages, status, sendMessage } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onError(err) {
      console.error("Chat error:", err);
      // Errors are now shown conversationally in the chat stream
    },
  });

  const isLoading = status === "streaming" || status === "submitted";

  // Rotate placeholder every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setPlaceholderIndex((prev) => (prev + 1) % ROTATING_PLACEHOLDERS.length);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Minimal mesh listener for core functionality (no UI exposure)
  useMesh((name, data) => {
    // Silent background processing - no UI updates
    if (name === "high_value_guest_reservation") {
      console.log("High value guest detected - could personalize experience");
    }
  });

  // Get user location on mount
  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setUserLocation({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          });
        },
        (error) => {
          console.error("Error getting location", error);
        }
      );
    }
  }, []);

  const handleClearChat = () => {
    setMessages([]);
    setSelectedRestaurant(null);
  };

  const handleSendMessage = async (text: string) => {
    if (!text.trim()) return;
    
    try {
      await sendMessage({ text }, { body: { userLocation } });
    } catch (err: any) {
      console.error("Failed to send message:", err);
    }
  };

  const onFormSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input.trim()) return;

    const message = input.trim();
    setInput("");
    await handleSendMessage(message);
  };

  const handleRestaurantSelect = (restaurant: Restaurant) => {
    setSelectedRestaurant(restaurant);
    const time = "7 PM";
    handleSendMessage(
      `I've selected ${restaurant.name} at ${restaurant.address}. Please add this to my calendar for tonight at ${time}.`
    );
  };

  const handleActionChipSelect = (value: string) => {
    handleSendMessage(value);
  };

  // Parse assistant messages for action chips (failover suggestions)
  const parseActionChips = (message: any): ActionChip[] | null => {
    // Look for structured failover suggestions in the message
    // This would be enhanced when FailoverPolicyEngine returns structured data
    const textParts = message.parts.filter((p: any) => p.type === "text");
    const fullText = textParts.map((p: any) => p.text).join("\n");

    // Simple pattern matching for alternatives (can be enhanced)
    const timePattern = /(\d+:\d+\s*(?:AM|PM))/gi;
    const times = fullText.match(timePattern);

    if (times && times.length > 0) {
      return times.slice(0, 3).map((time: string) => ({
        label: time,
        value: `Try ${time}`,
      }));
    }

    return null;
  };

  return (
    <main className="min-h-screen bg-white">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-md border-b border-slate-100">
        <div className="max-w-3xl mx-auto px-6 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">
              Intention Engine
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Your intelligent concierge
            </p>
          </div>
          {messages.length > 0 && (
            <button
              onClick={handleClearChat}
              className="flex items-center gap-1.5 text-slate-400 hover:text-red-500 transition-colors text-sm font-medium"
            >
              <Trash2 size={16} />
              <span className="hidden sm:inline">Clear</span>
            </button>
          )}
        </div>
      </header>

      {/* Chat Stream */}
      <div className="max-w-3xl mx-auto px-6 py-8 pb-48">
        {messages.length === 0 ? (
          <div className="text-center py-20">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-slate-50 mb-6">
              <MapPin className="w-8 h-8 text-slate-300" />
            </div>
            <h2 className="text-2xl font-bold text-slate-900 mb-2">
              What can I help you with today?
            </h2>
            <p className="text-slate-500 max-w-md mx-auto">
              I can book tables, schedule events, find rides, and more. Just tell
              me what you need.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {messages.map((message, index) => {
              const isLast = index === messages.length - 1;
              const isAssistant = message.role === "assistant";
              const actionChips = isAssistant ? parseActionChips(message) : null;

              return (
                <div key={message.id}>
                  <MessageBubble
                    message={message}
                    isLast={isLast}
                    isStreaming={isLoading && isLast}
                  />
                  {actionChips && (
                    <div className="ml-4 sm:ml-6">
                      <ActionChips
                        chips={actionChips}
                        onSelect={handleActionChipSelect}
                        disabled={isLoading}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Floating Input Bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-gradient-to-t from-white via-white to-transparent pt-20 pb-6">
        <div className="max-w-3xl mx-auto px-6">
          <form onSubmit={onFormSubmit} className="relative">
            <div className="relative flex items-center gap-2 bg-white border border-slate-200 rounded-2xl shadow-lg shadow-slate-200/50 focus-within:border-slate-300 focus-within:shadow-xl transition-all">
              <input
                ref={inputRef}
                type="text"
                className="flex-1 px-5 py-4 bg-transparent outline-none text-slate-900 placeholder:text-slate-400 text-[15px]"
                placeholder={ROTATING_PLACEHOLDERS[placeholderIndex]}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={isLoading}
                autoComplete="off"
              />
              <button
                type="button"
                className="p-2.5 text-slate-400 hover:text-slate-600 transition-colors rounded-full hover:bg-slate-50"
                aria-label="Voice input"
              >
                <Mic size={20} />
              </button>
              <button
                type="submit"
                disabled={isLoading || !input.trim()}
                className="p-2.5 bg-black text-white rounded-full hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                aria-label="Send message"
              >
                {isLoading ? (
                  <Loader2 size={20} className="animate-spin" />
                ) : (
                  <SendHorizontal size={20} />
                )}
              </button>
            </div>
            {userLocation && (
              <div className="flex items-center justify-center gap-1 mt-3 text-[11px] text-slate-400">
                <MapPin size={10} />
                <span>
                  {userLocation.lat.toFixed(2)}, {userLocation.lng.toFixed(2)}
                </span>
              </div>
            )}
          </form>
        </div>
      </div>
    </main>
  );
}
