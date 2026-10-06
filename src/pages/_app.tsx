import '@/styles/globals.scss';
import 'katex/dist/katex.min.css';

import type {AppProps} from 'next/app';
import {Inter, JetBrains_Mono} from 'next/font/google';
import {type FC, memo, useEffect} from 'react';

import {registerServiceWorker} from '@/lib/pwa';

const sans = Inter({subsets: ['latin'], variable: '--font-sans'});
const mono = JetBrains_Mono({subsets: ['latin'], variable: '--font-code', weight: ['400', '600']});

const App: FC<AppProps> = memo(({Component, pageProps}) => {
  useEffect(registerServiceWorker, []);
  return (
    <div className={`${sans.variable} ${mono.variable} font-sans`}>
      <Component {...pageProps} />
    </div>
  );
});
App.displayName = 'App';

export default App;
