import type { Clerk } from "@clerk/clerk-js";
import { ClerkProvider } from "@clerk/clerk-react";
import { dark } from "@clerk/themes";
import * as Sentry from "@sentry/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { Suspense } from "react";
import { match } from "ts-pattern";
import {
	ConfigProvider,
	FullscreenLoading,
	getConfig,
	ThirdPartyProviders,
	Toaster,
	TooltipProvider,
} from "@/components";
import { PageLayout } from "@/components/layout";
import { clerk } from "./lib/auth";
import { cloudEnv } from "./lib/env";
import { queryClient } from "./queries/global";
import { routeTree } from "./routeTree.gen";

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

export const router = createRouter({
	basepath: import.meta.env.BASE_URL,
	routeTree,
	context: {
		clerk:
			__APP_TYPE__ === "cloud" ? clerk : (undefined as unknown as Clerk),
		queryClient: queryClient,
	},
	defaultPreloadStaleTime: 0,
	defaultGcTime: 0,
	defaultPreloadGcTime: 0,
	defaultStaleTime: Infinity,
	scrollRestoration: true,
	defaultPendingMinMs: 300,
	defaultPendingComponent: FullscreenLoading,
	defaultOnCatch: (error) => {
		console.error("Router caught an error:", error);
		Sentry.captureException(error);
	},
});

function InnerApp() {
	return <RouterProvider router={router} />;
}

function CloudApp() {
	return (
		<ClerkProvider
			Clerk={clerk}
			appearance={{
				baseTheme: dark,
				variables: {
					colorPrimary: "hsl(var(--primary))",
					colorPrimaryForeground: "hsl(var(--primary-foreground))",
					colorTextOnPrimaryBackground:
						"hsl(var(--primary-foreground))",
					colorBackground: "hsl(var(--background))",
					colorInput: "hsl(var(--input))",
					colorText: "hsl(var(--text))",
					colorTextSecondary: "hsl(var(--muted-foreground))",
					borderRadius: "var(--radius)",
					colorModalBackdrop: "rgb(0 0 0 / 0.8)",
				},
			}}
			publishableKey={cloudEnv().VITE_CLERK_PUBLISHABLE_KEY}
		>
			<RouterProvider router={router} />
		</ClerkProvider>
	);
}

export function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<ConfigProvider value={getConfig()}>
				<ThirdPartyProviders>
					<Suspense fallback={<FullscreenLoading />}>
						<TooltipProvider>
							{match(__APP_TYPE__)
								.with("cloud", () => <CloudApp />)
								.otherwise(() => (
									<InnerApp />
								))}
						</TooltipProvider>
					</Suspense>
				</ThirdPartyProviders>

				<Toaster />
			</ConfigProvider>

			<ReactQueryDevtools client={queryClient} />
		</QueryClientProvider>
	);
}
