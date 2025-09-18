import {
	type RegisteredRouter,
	type RouteIds,
	useRouteContext,
} from "@tanstack/react-router";
import { match } from "ts-pattern";

export const useDataProvider = () =>
	match(__APP_TYPE__)
		.with("cloud", () => {
			// biome-ignore lint/correctness/useHookAtTopLevel: runs only once
			return useRouteContext({
				from: "/_context/_cloud/orgs/$organization/projects/$project/ns/$namespace",
			}).dataProvider;
		})
		.with("engine", () => {
			// biome-ignore lint/correctness/useHookAtTopLevel: runs only once
			return useRouteContext({
				from: "/_context/_engine/ns/$namespace",
			}).dataProvider;
		})
		.with("inspector", () => {
			// we need to narrow down the context for inspector, because inspector does not have a unique route prefix
			return match(
				// biome-ignore lint/correctness/useHookAtTopLevel: runs only once
				useRouteContext({
					from: "/_context",
				}),
			)
				.with({ __type: "inspector" }, (ctx) => ctx.dataProvider)
				.otherwise(() => {
					throw new Error("Not in an inspector-like context");
				});
		})
		.exhaustive();

export const useEngineDataProvider = () => {
	return useRouteContext({
		from: "/_context/_engine",
	}).dataProvider;
};

export const useInspectorDataProvider = () => {
	const context = useRouteContext({
		from: "/_context",
	});

	return match(context)
		.with({ __type: "inspector" }, (c) => c.dataProvider)
		.otherwise(() => {
			throw new Error("Not in an inspector-like context");
		});
};

type OnlyCloudRouteIds = Extract<
	RouteIds<RegisteredRouter["routeTree"]>,
	`/_context/_cloud/orgs/${string}`
>;

export const useCloudDataProvider = ({
	from = "/_context/_cloud/orgs/$organization",
}: {
	from?: OnlyCloudRouteIds;
} = {}) => {
	return useRouteContext({
		from,
	}).dataProvider;
};

export const useEngineCompatDataProvider = () => {
	return useRouteContext({
		from: match(__APP_TYPE__)
			.with("cloud", () => {
				return "/_context/_cloud/orgs/$organization/projects/$project/ns/$namespace" as const;
			})
			.with("engine", () => {
				return "/_context/_engine/ns/$namespace" as const;
			})
			.otherwise(() => {
				throw new Error("Not in an engine-like context");
			}),
	}).dataProvider;
};
