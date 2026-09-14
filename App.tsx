import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import type { InputMode, LanguageCode, TranslatorState } from './modules/live-translator';
import { useTranslator } from './src/useTranslator';

const FLAGS: Record<LanguageCode, string> = { en: '🇺🇸', es: '🇪🇸' };

const STATE_LABELS: Record<TranslatorState, string> = {
  idle: 'Stopped',
  preparing: 'Getting ready…',
  listening: 'Listening',
  translating: 'Translating…',
  speaking: 'Speaking',
};

const INPUT_MODES: { value: InputMode; label: string }[] = [
  { value: 'phone', label: 'iPhone mic' },
  { value: 'airpods', label: 'AirPods mic' },
];

export default function App() {
  return (
    <SafeAreaProvider>
      <TranslatorScreen />
    </SafeAreaProvider>
  );
}

function TranslatorScreen() {
  const [inputMode, setInputMode] = useState<InputMode>('phone');
  const translator = useTranslator();
  const { state, entries, live, error, languagesReady, languageStatus, downloading } = translator;
  const active = state !== 'idle';

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <Text style={styles.title}>AirPod Translator</Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, active && styles.dotActive]} />
          <Text style={styles.statusText}>{STATE_LABELS[state]}</Text>
        </View>
      </View>

      <View style={styles.segmented}>
        {INPUT_MODES.map((mode) => (
          <Pressable
            key={mode.value}
            disabled={active}
            onPress={() => setInputMode(mode.value)}
            style={[styles.segment, inputMode === mode.value && styles.segmentSelected, active && styles.disabled]}>
            <Text style={[styles.segmentText, inputMode === mode.value && styles.segmentTextSelected]}>
              {mode.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {languageStatus && !languagesReady && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            English and Spanish language packs are needed for on-device speech and translation.
          </Text>
          <Pressable style={styles.bannerButton} onPress={translator.downloadLanguages} disabled={downloading}>
            {downloading ? (
              <ActivityIndicator color="#0b1020" />
            ) : (
              <Text style={styles.bannerButtonText}>Download languages</Text>
            )}
          </Pressable>
        </View>
      )}

      {error && (
        <View style={styles.error}>
          <Text style={styles.errorText}>{error.message}</Text>
        </View>
      )}

      {live && (
        <View style={styles.live}>
          <Text style={styles.liveLabel}>{FLAGS[live.language]} Hearing</Text>
          <Text style={styles.liveText}>{live.text}</Text>
        </View>
      )}

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={entries}
        keyExtractor={(entry) => entry.id}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {active ? 'Listening for English or Spanish…' : 'Tap Start, then talk or play some Spanish.'}
          </Text>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.source}>
              {FLAGS[item.sourceLanguage]} {item.sourceText}
            </Text>
            <Text style={styles.translation}>
              {FLAGS[item.targetLanguage]} {item.translatedText}
            </Text>
          </View>
        )}
      />

      <View style={styles.footer}>
        {entries.length > 0 && !active && (
          <Pressable onPress={translator.clear} style={styles.clear}>
            <Text style={styles.clearText}>Clear</Text>
          </Pressable>
        )}
        <Pressable
          disabled={state === 'preparing' || !languagesReady}
          onPress={() => (active ? translator.stop() : translator.start(inputMode))}
          style={[
            styles.mainButton,
            active && styles.mainButtonStop,
            (state === 'preparing' || !languagesReady) && styles.disabled,
          ]}>
          <Text style={styles.mainButtonText}>{active ? 'Stop' : 'Start'}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const colors = {
  background: '#0b1020',
  surface: '#161d33',
  border: '#252e4d',
  text: '#f2f4fb',
  muted: '#8c95b3',
  accent: '#5b8cff',
  success: '#3ddc97',
  danger: '#ff5c7a',
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 16 },
  header: { paddingTop: 8, paddingBottom: 16 },
  title: { color: colors.text, fontSize: 28, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.muted, marginRight: 8 },
  dotActive: { backgroundColor: colors.success },
  statusText: { color: colors.muted, fontSize: 15 },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 4,
    marginBottom: 12,
  },
  segment: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center' },
  segmentSelected: { backgroundColor: colors.accent },
  segmentText: { color: colors.muted, fontWeight: '600' },
  segmentTextSelected: { color: colors.text },
  banner: { backgroundColor: colors.surface, borderRadius: 12, padding: 14, marginBottom: 12 },
  bannerText: { color: colors.text, fontSize: 15, marginBottom: 10 },
  bannerButton: { backgroundColor: colors.success, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  bannerButtonText: { color: colors.background, fontWeight: '700' },
  error: { backgroundColor: '#3a1522', borderRadius: 12, padding: 12, marginBottom: 12 },
  errorText: { color: colors.danger, fontSize: 14 },
  live: { borderLeftWidth: 3, borderLeftColor: colors.accent, paddingLeft: 12, marginBottom: 12 },
  liveLabel: { color: colors.muted, fontSize: 13, marginBottom: 2 },
  liveText: { color: colors.text, fontSize: 17, fontStyle: 'italic' },
  list: { flex: 1 },
  listContent: { paddingBottom: 12 },
  empty: { color: colors.muted, textAlign: 'center', marginTop: 48, fontSize: 15 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
  },
  source: { color: colors.muted, fontSize: 15, marginBottom: 6 },
  translation: { color: colors.text, fontSize: 19, fontWeight: '600' },
  footer: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  clear: { paddingHorizontal: 18, paddingVertical: 18, marginRight: 10 },
  clearText: { color: colors.muted, fontWeight: '600' },
  mainButton: {
    flex: 1,
    backgroundColor: colors.accent,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
  },
  mainButtonStop: { backgroundColor: colors.danger },
  mainButtonText: { color: colors.text, fontSize: 18, fontWeight: '700' },
  disabled: { opacity: 0.4 },
});
