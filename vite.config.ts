import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// Subscription providers are registered by src/providers.ts. An empty
	// built-in list keeps unrelated API-key providers out of the server build.
	plugins: [flue({ providers: [] })],
});
