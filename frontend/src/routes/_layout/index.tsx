import { useOrganization } from "@clerk/clerk-react";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { match } from "ts-pattern";
import { Card, CardContent, CardHeader, CardTitle } from "@/components";
import { useManager } from "@/components/actors";
import { RouteComponent as NamespaceRouteComponent } from "./ns.$namespace/index";

export const Route = createFileRoute("/_layout/")({
	component: match(__APP_TYPE__)
		.with("engine", () => RouteComponent)
		.with("inspector", () => NamespaceRouteComponent)
		.with("cloud", () => CloudRouteComponent)
		.exhaustive(),
});

function RouteComponent() {
	const { data: namespaces } = useSuspenseInfiniteQuery(
		useManager().namespacesQueryOptions(),
	);

	if (namespaces.length <= 0) {
		return (
			<div className="flex size-full">
				<Card className="max-w-md w-full mb-6 mx-auto self-center">
					<CardHeader>
						<CardTitle>No namespaces found</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="mb-4">
							Please consult the documentation for more
							information.
						</p>
					</CardContent>
				</Card>
			</div>
		);
	}

	return (
		<Navigate
			to="/ns/$namespace"
			params={{ namespace: namespaces[0].name }}
			replace
		/>
	);
}

function CloudRouteComponent() {
	const { isLoaded, organization } = useOrganization();

	if (!isLoaded || !organization) {
		return null;
	}

	return (
		<Navigate
			to="/orgs/$organization"
			params={{ organization: organization.id }}
			replace
		/>
	);
}
