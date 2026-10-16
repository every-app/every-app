import { Link } from "@tanstack/react-router";
import { StatusScreen } from "@/client/components/StatusScreen";
import { Button } from "@/client/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/client/components/ui/card";

export function NotFound({ children }: { children?: React.ReactNode }) {
  return (
    <StatusScreen>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>404</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground">
          {children || <p>The page you are looking for does not exist.</p>}
        </CardContent>
        <CardFooter>
          <Button nativeButton={false} render={<Link to="/" />}>
            Home
          </Button>
        </CardFooter>
      </Card>
    </StatusScreen>
  );
}
