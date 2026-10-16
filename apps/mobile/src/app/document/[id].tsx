import { createElement, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import * as Print from 'expo-print';
import { WebView } from 'react-native-webview';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { RequireLogin } from '../../components/require-login';
import { Button, ErrorText, Loading, Screen } from '../../components/ui';

export default function DocumentScreen() {
  return <RequireLogin><DocumentView /></RequireLogin>;
}

/** The issued document rendered exactly as on the website, with printing / saving as PDF. */
function DocumentView() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const tr = useTr();
  const { lang } = useSession();
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.raw('GET', `/v1/documents/${id}`, { query: { format: 'html', lang } });
        if (!res.ok) throw new Error(`${res.status}`);
        const text = await res.text();
        if (alive) setHtml(text);
      } catch (e) { if (alive) setError(e); }
    })();
    return () => { alive = false; };
  }, [id, lang]);
  return (
    <Screen scroll={false}>
      <Stack.Screen options={{ title: title ?? tr({ ar: 'مستند', en: 'Document' }) }} />
      <ErrorText error={error} />
      {!html && !error ? <Loading /> : null}
      {html ? <>
        <Button testID="print-document" title={tr({ ar: 'طباعة أو حفظ PDF', en: 'Print or save as PDF' })} onPress={() => void Print.printAsync({ html }).catch(setError)} />
        <View testID="document-view" style={{ flex: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: '#fff' }}>
          {Platform.OS === 'web'
            ? createElement('iframe', { srcDoc: html, title: 'document', sandbox: '', style: { border: 0, width: '100%', height: '100%', minHeight: 600 } })
            : <WebView originWhitelist={['about:blank']} source={{ html }} javaScriptEnabled={false} style={{ flex: 1 }} />}
        </View>
      </> : null}
    </Screen>
  );
}
