<?php
declare(strict_types=1);

namespace Corpus;

interface Shape
{
    public function area(): float;
}

final class Rect implements Shape
{
    public function __construct(private float $w, private float $h) {}

    public function area(): float
    {
        return $this->w * $this->h;
    }
}

function total(Shape ...$shapes): float
{
    $sum = 0.0;
    foreach ($shapes as $shape) {
        $sum += $shape->area();
    }
    return $sum;
}

$result = match (true) {
    total(new Rect(1.0, 2.0)) > 1.0 => "big",
    default => "small",
};
echo "result: {$result}\n";
