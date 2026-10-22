import { CopilotKitCoreRuntimeConnectionStatus, useAgent, useCopilotKit, useRenderToolCall } from "@copilotkit/react-native/headless";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { ListRenderItemInfo, TextInputKeyPressEvent } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { fetchDocuments } from "../../lib/api";
import type { ProjectDocument } from "../../lib/api";
import { describeUnverified, pageDocuments, toChatItems, trimToLastQuestion } from "../../lib/chat";
import type { ChatItem } from "../../lib/chat";
import { colors, radius, spacing } from "../../lib/theme";
import { useCachedResource } from "../../lib/useCachedResource";
import { useReconnectCopilot } from "../ProjectCopilot";
import { A2UIActivity } from "../a2ui/A2UISurface";
import { A2UIPageProvider } from "../a2ui/sourcePage";
import { MessageText } from "./MessageText";
import { usePageViewer } from "./PageViewer";
import { useChatToolRenderers } from "./useChatToolRenderers";

const SUGGESTIONS = ["Jaka jest grubość ocieplenia ścian?", "Pokaż rzut parteru", "Z czego jest wylewka na parterze?"];

const RUN_ERROR = "Nie udało się dostać odpowiedzi. Sprawdź zasięg i spróbuj ponownie.";

const useConnectionStatus = () => {
  const { copilotkit } = useCopilotKit();
  const [status, setStatus] = useState(copilotkit.runtimeConnectionStatus);
  useEffect(() => {
    setStatus(copilotkit.runtimeConnectionStatus);
    const subscription = copilotkit.subscribe({ onRuntimeConnectionStatusChanged: ({ status: next }) => setStatus(next) });
    return () => subscription.unsubscribe();
  }, [copilotkit]);
  return status;
};

// "str. N" in an answer has no document id. Tool calls usually tell us; otherwise fall back to the project's first PDF.
// The list shares its saved copy with the "Projekt" tab, so cited pages still open without signal.
const useProjectDocuments = (projectId: string): ProjectDocument[] =>
  useCachedResource(`documents-${projectId}`, (connection) => fetchDocuments(connection, projectId), "").data ?? [];

export const ProjectChat = ({ projectId }: { projectId: string }) => {
  const { copilotkit } = useCopilotKit();
  const { agent, isReady } = useAgent();
  const status = useConnectionStatus();
  const reconnect = useReconnectCopilot();
  const renderToolCall = useRenderToolCall();
  const openPage = usePageViewer();
  const documents = useProjectDocuments(projectId);
  const headerHeight = useHeaderHeight();
  useChatToolRenderers();

  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatItem>>(null);

  const messages = agent.messages;
  const isRunning = agent.isRunning;
  const items = toChatItems(messages, isRunning);

  const openCitedPage = useCallback(
    (pageNo: number, sourceDocumentId?: string) => {
      const documentId = sourceDocumentId ?? pageDocuments(agent.messages).get(pageNo) ?? documents[0]?.id;
      if (documentId) openPage({ documentId, pageNo });
    },
    [agent, documents, openPage],
  );

  const run = useCallback(async () => {
    setError(null);
    try {
      await copilotkit.runAgent({ agent });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") return;
      setError(RUN_ERROR);
    }
  }, [agent, copilotkit]);

  // A failed run reports through the agent's events rather than always rejecting, so listen for both.
  useEffect(() => {
    const subscription = agent.subscribe({
      onRunFailed: () => setError(RUN_ERROR),
      onRunErrorEvent: () => setError(RUN_ERROR),
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  const send = useCallback(
    (text: string) => {
      const question = text.trim();
      if (!question || isRunning || !isReady) return;
      setInput("");
      agent.addMessage({ id: `user-${Date.now()}`, role: "user", content: question });
      void run();
    },
    [agent, isReady, isRunning, run],
  );

  // In the browser Enter sends, as in other web chats; Shift+Enter starts a new line.
  const sendOnEnter = useCallback(
    (event: TextInputKeyPressEvent) => {
      const { key, shiftKey } = event.nativeEvent as { key: string; shiftKey?: boolean };
      if (key !== "Enter" || shiftKey) return;
      event.preventDefault();
      send(input);
    },
    [input, send],
  );

  const retry = useCallback(() => {
    agent.setMessages(trimToLastQuestion(agent.messages));
    void run();
  }, [agent, run]);

  const stop = useCallback(() => copilotkit.stopAgent({ agent }), [agent, copilotkit]);

  const renderItem = ({ item }: ListRenderItemInfo<ChatItem>) => {
    switch (item.kind) {
      case "user":
        return (
          <View style={[styles.bubble, styles.userBubble]}>
            <Text style={styles.userText}>{item.text}</Text>
          </View>
        );
      case "assistant":
        return (
          <View style={styles.assistantBlock}>
            <MessageText text={item.text} onOpenPage={openCitedPage} unverifiedPages={item.unverifiedPages} />
          </View>
        );
      case "citations":
        return (
          <View style={styles.citationWarning} accessibilityRole="alert">
            <Text style={styles.citationWarningText}>
              Nie potwierdzono źródła: {describeUnverified(item.unverified)}. Agent nie dostał tej strony z wyszukiwania ani
              odczytu, sprawdź ją w projekcie.
            </Text>
          </View>
        );
      case "tool":
        return <View style={styles.toolBlock}>{renderToolCall({ toolCall: item.toolCall, toolMessage: item.result })}</View>;
      case "surface":
        return (
          <View style={styles.toolBlock}>
            <A2UIPageProvider value={openCitedPage}>
              <A2UIActivity activity={item.activity} />
            </A2UIPageProvider>
          </View>
        );
      case "thinking":
        return <Text style={styles.thinking}>Asystent pracuje…</Text>;
    }
  };

  const connectionLost = !isReady && status === CopilotKitCoreRuntimeConnectionStatus.Error;
  const canSend = input.trim().length > 0 && isReady && !isRunning;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <FlatList
        ref={listRef}
        style={styles.flex}
        contentContainerStyle={items.length ? styles.list : styles.emptyList}
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        extraData={`${messages.length}:${isRunning}:${documents.length}`}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Zapytaj o projekt</Text>
            <Text style={styles.emptyText}>Asystent szuka odpowiedzi w dokumentacji i podaje stronę, z której ją wziął.</Text>
            {SUGGESTIONS.map((suggestion) => (
              <Pressable
                key={suggestion}
                accessibilityRole="button"
                disabled={!isReady}
                onPress={() => send(suggestion)}
                style={({ pressed }) => [styles.suggestion, pressed && styles.pressed, !isReady && styles.disabled]}
              >
                <Text style={styles.suggestionText}>{suggestion}</Text>
              </Pressable>
            ))}
          </View>
        }
      />

      {connectionLost ? (
        <View style={styles.banner} accessibilityLiveRegion="assertive">
          <Text style={styles.bannerText}>Brak połączenia z asystentem. Sprawdź zasięg.</Text>
          <Pressable accessibilityRole="button" onPress={reconnect} style={styles.bannerButton}>
            <Text style={styles.bannerButtonText}>Połącz ponownie</Text>
          </Pressable>
        </View>
      ) : error && !isRunning ? (
        <View style={styles.banner} accessibilityLiveRegion="assertive">
          <Text style={styles.bannerText}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={retry} style={styles.bannerButton}>
            <Text style={styles.bannerButtonText}>Ponów</Text>
          </Pressable>
        </View>
      ) : null}

      <SafeAreaView edges={["bottom"]} style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={isReady ? "Napisz pytanie…" : "Łączę z asystentem…"}
          placeholderTextColor={colors.muted}
          multiline
          onKeyPress={Platform.OS === "web" ? sendOnEnter : undefined}
          editable={!connectionLost}
          accessibilityLabel="Pytanie do asystenta"
        />
        {isRunning ? (
          <Pressable accessibilityRole="button" onPress={stop} style={[styles.sendButton, styles.stopButton]}>
            <Text style={styles.stopLabel}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Wyślij pytanie"
            disabled={!canSend}
            onPress={() => send(input)}
            style={({ pressed }) => [styles.sendButton, !canSend && styles.disabled, pressed && styles.pressed]}
          >
            <Text style={styles.sendLabel}>Wyślij</Text>
          </Pressable>
        )}
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: spacing.md, gap: spacing.md },
  emptyList: { flexGrow: 1, padding: spacing.md, justifyContent: "flex-end" },
  empty: { gap: spacing.sm },
  emptyTitle: { fontSize: 20, fontWeight: "700", color: colors.text },
  emptyText: { fontSize: 15, lineHeight: 21, color: colors.muted, marginBottom: spacing.sm },
  suggestion: {
    alignSelf: "flex-start",
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  suggestionText: { fontSize: 15, color: colors.text },
  bubble: { maxWidth: "85%", borderRadius: radius.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
  userBubble: { alignSelf: "flex-end", backgroundColor: colors.text },
  citationWarning: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerBg },
  citationWarningText: { fontSize: 14, lineHeight: 20, color: colors.danger },
  userText: { fontSize: 16, lineHeight: 22, color: colors.surface },
  assistantBlock: { paddingRight: spacing.lg },
  toolBlock: { alignSelf: "stretch" },
  thinking: { fontSize: 14, color: colors.muted },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: "#FDECEA",
  },
  bannerText: { flex: 1, fontSize: 14, lineHeight: 20, color: colors.danger },
  bannerButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.danger },
  bannerButtonText: { fontSize: 15, fontWeight: "600", color: colors.accentText },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 140,
    paddingHorizontal: spacing.md,
    paddingTop: 13,
    paddingBottom: 13,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: 16,
    color: colors.text,
  },
  sendButton: { minHeight: 48, justifyContent: "center", paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.accent },
  sendLabel: { fontSize: 16, fontWeight: "600", color: colors.accentText },
  stopButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  stopLabel: { fontSize: 16, fontWeight: "600", color: colors.text },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
});
