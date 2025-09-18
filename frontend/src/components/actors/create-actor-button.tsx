import { faPlus, Icon } from "@rivet-gg/icons";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button, type ButtonProps, WithTooltip } from "@/components";
import { useActorsView } from "./actors-view-context-provider";
import { useDataProvider } from "./data-provider";

export function CreateActorButton(props: ButtonProps) {
	const navigate = useNavigate();

	const provider = useDataProvider();
	const { data } = useInfiniteQuery(useDataProvider().buildsQueryOptions());

	const { copy } = useActorsView();

	const canCreate = data && data.length > 0;

	if (!provider.features.canCreateActors) {
		return null;
	}

	const content = (
		<div>
			<Button
				disabled={!canCreate}
				size="sm"
				variant="ghost"
				onClick={() => {
					navigate({
						to: ".",
						search: (prev) => ({
							...prev,
							modal: "create-actor",
						}),
					});
				}}
				startIcon={<Icon icon={faPlus} />}
				{...props}
			>
				{copy.createActor}
			</Button>
		</div>
	);

	if (canCreate) {
		return content;
	}

	return (
		<WithTooltip
			trigger={content}
			content={
				data && data.length <= 0
					? "Please deploy a build first."
					: copy.createActorUsingForm
			}
		/>
	);
}
